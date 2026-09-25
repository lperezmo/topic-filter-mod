"""Turns raw titles into candidates: qualifiers stripped, noise dropped, duplicates merged.

Duplicates are merged by the mod's own fold, so two spellings the mod would
treat as one term (`Teotihuacan`, `Teotihuacán`) become one candidate.
"""

import re
import unicodedata
from dataclasses import dataclass, field

from topic_packs.matcher import fold_term

MAX_WORDS = 5

_NAMESPACE = re.compile(
    r"^(Category|Template|Portal|Wikipedia|Help|File|Draft|Module|Appendix|Thesaurus|Rhymes|"
    r"Reconstruction|Citations|Concordance|Index|Wiktionary|Special)( talk)?:",
    re.IGNORECASE,
)
_LIST_PAGE = re.compile(r"^(lists? of|outline of|index of|timeline of|glossary of|bibliography of)\b", re.I)
_TRAILING_PARENS = re.compile(r"\s*\([^()]*\)\s*$")
_NUMBER_TOKEN = re.compile(r"^\d+(s|st|nd|rd|th)?$", re.IGNORECASE)


@dataclass(frozen=True)
class Origin:
    """Where a candidate came from: the recipe source's index, kind and role."""

    source: int
    kind: str
    role: str


@dataclass
class Candidate:
    """One folded term on its way into the pack, with what was learned about it."""

    text: str
    key: str
    origins: list[Origin] = field(default_factory=list)
    zipf: float = 0.0
    #: "term", "hint" or "drop".
    decision: str = ""
    #: Why the candidate went to review; empty when it never did.
    review: list[str] = field(default_factory=list)
    #: Why it was dropped, or why it is a term when that is not the obvious reason.
    reason: str = ""
    hits: int = 0
    files: int = 0
    judge: float | None = None

    @property
    def kinds(self) -> set[str]:
        return {o.kind for o in self.origins}


def clean_title(raw: str) -> tuple[str | None, str]:
    """A title made into a candidate's text, or None and the reason it was dropped."""
    text = " ".join(unicodedata.normalize("NFC", raw).split())
    if not text:
        return None, "empty"
    if _NAMESPACE.match(text):
        return None, "namespace page"
    if _LIST_PAGE.match(text):
        return None, "list or outline page"

    while _TRAILING_PARENS.search(text):
        text = _TRAILING_PARENS.sub("", text)
    if ", " in text:
        text = text.split(", ", 1)[0]
    text = text.strip(" ,;:")

    if text.startswith(("-", "*")) or text.endswith("-"):
        return None, "affix or reconstruction"
    tokens = text.split(" ")
    if any(_NUMBER_TOKEN.match(t) for t in tokens):
        return None, "number or year"
    if len(fold_term(text)) <= 2:
        return None, "too short"
    letters = [c for c in text if c.isalnum()]
    if text.isupper() and len(letters) <= 4:
        return None, "short acronym"
    if len(letters) < 3:
        return None, "too few letters"
    if len(tokens) > MAX_WORDS:
        return None, f"longer than {MAX_WORDS} words"
    return text, ""


def _niceness(text: str) -> tuple[int, int]:
    """Accents first, then capitals: `Teotihuacán` over `teotihuacan`."""
    return sum(1 for c in text if ord(c) > 127 and c.isalpha()), sum(1 for c in text if c.isupper())


def merge(items: list[tuple[str, Origin]]) -> tuple[list[Candidate], list[Candidate]]:
    """Cleans and merges raw items: (candidates, dropped), each deduplicated by folded key."""
    kept: dict[str, Candidate] = {}
    dropped: dict[str, Candidate] = {}
    for raw, origin in items:
        text, reason = clean_title(raw)
        if text is None:
            key = fold_term(raw) or raw
            if key not in dropped:
                dropped[key] = Candidate(raw.strip(), key, [origin], decision="drop", reason=reason)
            elif origin not in dropped[key].origins:
                dropped[key].origins.append(origin)
            continue

        key = fold_term(text)
        found = kept.get(key)
        if found is None:
            kept[key] = Candidate(text, key, [origin])
            continue
        if origin not in found.origins:
            found.origins.append(origin)
        if _niceness(text) > _niceness(found.text):
            found.text = text

    # A title dropped in one source but kept from another is not dropped.
    return list(kept.values()), [c for k, c in dropped.items() if k not in kept]
