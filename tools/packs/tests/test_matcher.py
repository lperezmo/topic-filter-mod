"""Parity with hooks/matcher.ts: the first six cases mirror describe('matcher') in tests/filter.test.ts."""

from topic_packs.matcher import Matcher, fold, fold_term, fold_text


def matcher_of(*terms: str, word_only: bool = True) -> Matcher:
    m = Matcher()
    for term in terms:
        m.add(term, word_only=word_only)
    return m


def found(m: Matcher, text: str) -> list[str]:
    return [text[x.start : x.end] for x in m.find(text)]


def test_ignores_accents_and_case():
    m = matcher_of("Teotihuacan")
    assert found(m, "Teotihuacán, TEOTIHUACAN and teotihuacan") == [
        "Teotihuacán",
        "TEOTIHUACAN",
        "teotihuacan",
    ]


def test_matches_whole_words_only_with_plural_and_possessive_endings():
    m = matcher_of("Maya")
    text = "the Maya, two Mayas, the Maya\u2019s calendar, Mayapan, Himalaya"
    assert found(m, text) == ["Maya", "Mayas", "Maya"]


def test_a_substring_list_matches_inside_words():
    m = matcher_of("maya", word_only=False)
    assert found(m, "Mayapan") == ["Maya"]


def test_spaces_hyphens_and_underscores_are_one_separator():
    m = matcher_of("secret repo")
    assert found(m, "secret-repo secret_repo secret  repo secretrepo") == [
        "secret-repo",
        "secret_repo",
        "secret  repo",
    ]


def test_takes_the_longest_term_at_a_position():
    m = matcher_of("Giza", "Pyramids of Giza")
    assert found(m, "the Pyramids of Giza and Giza itself") == ["Pyramids of Giza", "Giza"]


def test_finds_a_term_inside_a_path():
    m = matcher_of("secret-repo")
    assert found(m, "D:\\Python\\secret-repo\\main.py and /home/me/secret-repo/") == [
        "secret-repo",
        "secret-repo",
    ]


def test_plural_es_is_taken_and_reported_as_the_suffix():
    m = matcher_of("tomato")
    [match] = m.find("two Tomatoes.")
    assert (match.folded, match.suffix) == ("tomato", "es")


def test_a_plural_that_is_itself_a_term_wins():
    m = matcher_of("maya", "mayas")
    assert [x.folded for x in m.find("Mayas")] == ["mayas"]


def test_word_and_substring_terms_share_one_matcher():
    m = Matcher()
    m.add("maya")
    m.add("pan", word_only=False)
    assert found(m, "Mayapan and the Maya") == ["pan", "Maya"]


def test_terms_shorter_than_two_folded_units_are_ignored():
    m = Matcher()
    assert m.add("a") is None
    assert m.add(" - ") is None
    assert len(m) == 0


def test_dashes_and_unicode_spaces_are_separators_but_python_only_spaces_are_not():
    assert fold_term("Chan\u2014Chan") == "chan chan"
    assert fold_term("Chan\u00a0Chan") == "chan chan"
    assert fold_term("a\x1cb") == "a\x1cb"


def test_curly_apostrophes_fold_to_straight_ones():
    assert fold_term("K\u2019iche\u2018") == "k'iche'"


def test_fast_fold_equals_the_positional_fold():
    samples = [
        "Teotihuacán and ÇATALHÖYÜK",
        "ΟΔΟΣ Σ σ ς",
        "İstanbul ǅ",
        "tabs\tand\u3000ideographic spaces\ufeff",
        "curly \u2019quotes\u2018 and \u201cdoubles\u201d",
        "x\u2010y\u2011z\u2015w -- __ \n\r\n",
        "emoji \U0001f600 and ﬁ ligature",
    ]
    for text in samples:
        assert fold_text(text) == fold(text).text


def test_fold_keeps_original_spans():
    folded = fold("Á  b")
    assert folded.text == "a b"
    assert (folded.starts, folded.ends) == ([0, 1, 3], [1, 3, 4])


def test_count_tallies_hits_per_folded_term():
    m = matcher_of("Tikal", "Chichen Itza")
    counts = m.count("Tikal, TIKAL and chichen-itza; Tikals; tikalito")
    assert counts == {"tikal": 3, "chichen itza": 1}
