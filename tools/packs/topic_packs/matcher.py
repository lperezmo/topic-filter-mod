"""A port of hooks/matcher.ts: the same fold and the same matching rules.

Packs are deduplicated and dry-run with this, so it must agree with what the
mod hides: accents and case ignored, runs of spaces, hyphens and underscores
one separator, whole words only (plus a plural `s` or `es`), leftmost first
and longest at each start. Positions are code point indices, where the mod
counts UTF-16 units; the two differ only after astral characters.

Matching compiles the terms into one trie-shaped regular expression, which
walks the text in C instead of a Python loop per character.
"""

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache

# JavaScript's \s, which the mod uses (Python's \s adds \x1c-\x1f and \x85),
# then hyphen, underscore and the dashes U+2010-U+2015.
_JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_SEPARATOR = re.compile(f"[{_JS_SPACE}\\-_\u2010-\u2015]")
_SEPARATOR_RUN = re.compile(f"[{_JS_SPACE}\\-_\u2010-\u2015]+")
_NON_ASCII_RUN = re.compile(r"[^\x00-\x7f]+")

# [^\W_] is exactly JavaScript's [\p{L}\p{N}] in CPython (checked over every code point).
_WORD = r"[^\W_]"
_WORD_CHAR = re.compile(_WORD)

# The mod ignores terms shorter than this once folded (MIN_TERM_LENGTH in redact.ts).
MIN_TERM_LENGTH = 2


@lru_cache(maxsize=65536)
def fold_char(ch: str) -> str:
    """Folds one code point: curly quotes to `'`, accents dropped, lower case."""
    if ch in "\u2019\u2018":
        return "'"
    decomposed = unicodedata.normalize("NFD", ch)
    return "".join(c for c in decomposed if not unicodedata.category(c).startswith("M")).lower()


@dataclass(frozen=True)
class Folded:
    """Text folded for matching, with each folded unit's span in the original."""

    text: str
    starts: list[int]
    ends: list[int]


def fold(text: str) -> Folded:
    """Folds a whole text, keeping where each folded unit came from (fold in matcher.ts)."""
    out: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    last_was_separator = False

    for pos, ch in enumerate(text):
        if _SEPARATOR.match(ch):
            if last_was_separator:
                ends[-1] = pos + 1
            else:
                out.append(" ")
                starts.append(pos)
                ends.append(pos + 1)
            last_was_separator = True
            continue

        last_was_separator = False
        for unit in fold_char(ch):
            out.append(unit)
            starts.append(pos)
            ends.append(pos + 1)

    return Folded("".join(out), starts, ends)


def fold_text(text: str) -> str:
    """`fold(text).text` without the spans, fast enough for a whole corpus."""
    if not text.isascii():
        text = _NON_ASCII_RUN.sub(lambda m: "".join(fold_char(c) for c in m.group()), text)
    return _SEPARATOR_RUN.sub(" ", text.lower())


def fold_term(term: str) -> str:
    """A term folded on its own, trimmed: the key terms are compared by."""
    return fold_text(term).strip()


@dataclass(frozen=True)
class Match:
    """A term found in a text: `[start, end)` in the original's code points."""

    start: int
    end: int
    folded: str
    canonical: str
    #: A plural ending (`s`, `es`) the match took after the term, as written.
    suffix: str


# At a word-only term's end: a boundary, or a plural ending and then one. In a
# matcher that also holds substring terms, only when the match began on a boundary.
_WORD_END = rf"(?:es|s)?(?!{_WORD})"
_MIXED_WORD_END = rf"(?(b){_WORD_END}|(?!))"


class Matcher:
    """Matches a set of terms in text, leftmost first and longest at each start."""

    def __init__(self) -> None:
        self._terms: dict[str, tuple[str, bool]] = {}
        self._pattern: re.Pattern[str] | None = None

    def __len__(self) -> int:
        return len(self._terms)

    def add(self, term: str, *, word_only: bool = True) -> str | None:
        """Adds a term; returns its folded key, or None when too short to use."""
        folded = fold_term(term)
        if len(folded) < MIN_TERM_LENGTH:
            return None
        if folded not in self._terms:
            self._terms[folded] = (term, word_only)
            self._pattern = None
        return folded

    def find(self, text: str) -> list[Match]:
        """Every term in `text`, left to right, none overlapping."""
        if not self._terms or not text:
            return []
        folded = fold(text)
        matches = []
        for m in self._compiled().finditer(folded.text):
            key = self._term_of(m.group())
            term_end = folded.ends[m.start() + len(key) - 1]
            end = folded.ends[m.end() - 1]
            matches.append(Match(folded.starts[m.start()], end, key, self._terms[key][0], text[term_end:end]))
        return matches

    def count(self, text: str) -> Counter[str]:
        """Hits per folded term in `text`, without positions."""
        if not self._terms or not text:
            return Counter()
        return Counter(self._term_of(m.group()) for m in self._compiled().finditer(fold_text(text)))

    def _term_of(self, matched: str) -> str:
        """The term behind a match: the longest of it, it less `s`, it less `es` that is held.

        The expression prefers longer terms, so when `mayas` is itself a term
        it wins over `maya` plus `s`; the longest held reading is the one taken.
        """
        if matched in self._terms:
            return matched
        if matched.endswith("s") and matched[:-1] in self._terms:
            return matched[:-1]
        return matched[:-2]

    def _compiled(self) -> re.Pattern[str]:
        if self._pattern is None:
            mixed = not all(word_only for _, word_only in self._terms.values())
            root: dict = {}
            for key, (_, word_only) in self._terms.items():
                node = root
                for ch in key:
                    node = node.setdefault(ch, {})
                node[""] = (_MIXED_WORD_END if mixed else _WORD_END) if word_only else ""
            if mixed:
                # `b` is set when the match starts on a word boundary; word-only ends require it.
                self._pattern = re.compile(rf"(?:(?<!{_WORD})(?P<b>)|){_trie_pattern(root)}")
            else:
                self._pattern = re.compile(rf"(?<!{_WORD}){_trie_pattern(root)}")
        return self._pattern


def _trie_pattern(node: dict) -> str:
    """A trie as a regular expression: longer continuations tried before a term ends here."""
    parts = [re.escape(ch) + _trie_pattern(child) for ch, child in sorted(node.items()) if ch]
    if "" in node:
        parts.append(node[""])
    if len(parts) == 1:
        return parts[0]
    return "(?:" + "|".join(parts) + ")"


def is_word_char(ch: str) -> bool:
    """A letter or digit, as the mod's word boundaries see it."""
    return bool(_WORD_CHAR.match(ch))
