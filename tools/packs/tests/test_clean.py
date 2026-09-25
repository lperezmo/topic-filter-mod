import pytest

from topic_packs.clean import Origin, clean_title, merge

WIKI = Origin(0, "wikipedia-category", "terms")
WIKT = Origin(1, "wiktionary-category", "hints")


@pytest.mark.parametrize(
    ("raw", "cleaned"),
    [
        ("Tikal (Mesoamerican site)", "Tikal"),
        ("La Blanca, Peten", "La Blanca"),
        ("Caracol (Belize) (site)", "Caracol"),
        ("  Chichen   Itza ", "Chichen Itza"),
        ("KV62 tomb", "KV62 tomb"),
    ],
)
def test_cleans_titles(raw, cleaned):
    assert clean_title(raw) == (cleaned, "")


@pytest.mark.parametrize(
    ("raw", "reason"),
    [
        ("List of Maya sites", "list or outline page"),
        ("Lists of pyramids", "list or outline page"),
        ("Outline of archaeology", "list or outline page"),
        ("Index of Egypt-related articles", "list or outline page"),
        ("Timeline of the Maya", "list or outline page"),
        ("Category:Maya sites", "namespace page"),
        ("2012 phenomenon", "number or year"),
        ("1500s in Mexico", "number or year"),
        ("AI", "too short"),
        ("Ra", "too short"),
        ("ANT", "short acronym"),
        ("AAS", "short acronym"),
        ("-ology", "affix or reconstruction"),
        ("anthropo-", "affix or reconstruction"),
        ("Archaeological Zone of Monte Alban and Mitla", "longer than 5 words"),
    ],
)
def test_drops_noise(raw, reason):
    assert clean_title(raw) == (None, reason)


def test_merges_by_the_mods_fold_and_keeps_the_nicest_spelling():
    kept, dropped = merge(
        [("teotihuacan", WIKT), ("Teotihuacán", WIKI), ("Teotihuacan", WIKI), ("maya", WIKT), ("Maya", WIKI)]
    )
    assert [c.text for c in kept] == ["Teotihuacán", "Maya"]
    assert kept[0].origins == [WIKT, WIKI]
    assert dropped == []


def test_a_title_kept_from_one_source_is_not_also_dropped():
    kept, dropped = merge([("AAS", WIKT), ("Aas", WIKI)])
    assert [c.text for c in kept] == ["Aas"]
    assert dropped == []


def test_drops_are_deduplicated_and_remember_their_sources():
    _, dropped = merge([("AI", WIKT), ("AI", WIKI)])
    assert len(dropped) == 1
    assert dropped[0].reason == "too short"
    assert dropped[0].origins == [WIKT, WIKI]
