from conftest import fake_zipf

from topic_packs.classify import classify, english_zipf, flag_corpus_hits, resolve, zipf_of
from topic_packs.clean import Candidate, Origin
from topic_packs.matcher import fold_term
from topic_packs.recipe import Thresholds, parse_recipe

TERMS = Origin(0, "wikipedia-category", "terms")
VOCAB = Origin(1, "wiktionary-category", "hints")
DATAMUSE = Origin(2, "datamuse-rel-trg", "hints")


def recipe(**extra):
    return parse_recipe({"name": "t", "description": "Test.", "wikipedia": [{"category": "X"}], **extra})


def run(text, origin, **extra):
    c = Candidate(text, fold_term(text), [origin])
    classify([c], recipe(**extra), fake_zipf)
    return c


def test_a_rare_name_from_a_terms_source_is_a_term():
    c = run("Tikal", TERMS)
    assert (c.decision, c.review, c.zipf) == ("term", [], 2.08)


def test_a_moderately_common_name_goes_to_review_as_a_hint():
    c = run("Maya", TERMS)
    assert (c.decision, c.review) == ("hint", ["moderately common word"])


def test_a_common_name_is_a_hint_and_a_very_common_one_is_dropped():
    assert run("Temple", TERMS).decision == "hint"
    assert run("Sun", TERMS).decision == "drop"


def test_a_name_made_only_of_common_words_goes_to_review():
    c = run("Baking Pot", TERMS)
    assert (c.decision, c.review) == ("hint", ["every word is common"])
    assert run("Age Set", TERMS).decision == "drop"


def test_a_name_with_one_rare_word_is_a_term():
    assert run("La Blanca", TERMS).decision == "term"


def test_vocabulary_is_a_hint_unless_very_rare():
    assert run("kinship", VOCAB).decision == "hint"
    assert (run("affinal", VOCAB).decision, run("affinal", VOCAB).reason) == ("term", "rare vocabulary")
    assert run("age set", VOCAB).decision == "hint"
    assert run("the", VOCAB).decision == "drop"


def test_datamuse_only_ever_feeds_hints():
    assert run("epigraphy", DATAMUSE).decision == "hint"


def test_recipe_lists_override_frequency():
    assert run("Sun", Origin(3, "recipe", "terms")).decision == "term"
    assert run("affinal", Origin(3, "recipe", "hints")).decision == "hint"
    c = run("Tikal", TERMS, exclude=["TIKAL"])
    assert (c.decision, c.reason) == ("drop", "excluded by the recipe")


def test_zipf_is_the_commoner_of_written_and_folded_spellings():
    table = {"Teotihuacán": 0.5, "teotihuacan": 2.12}
    assert zipf_of("Teotihuacán", lambda t: table.get(t, 0.0)) == 2.12


def test_corpus_hits_send_terms_to_review_but_not_recipe_terms():
    t = Thresholds()
    busy = Candidate("Llama", "llama", [TERMS], decision="term", files=4)
    quiet = Candidate("Tikal", "tikal", [TERMS], decision="term", files=3)
    listed = Candidate("Giza", "giza", [TERMS], decision="term", reason="listed in extra_terms", files=40)
    assert flag_corpus_hits([busy, quiet, listed], t) == 1
    assert (busy.decision, busy.review) == ("hint", ["in 4 corpus files"])
    assert quiet.decision == listed.decision == "term"


def test_judge_answers_settle_review_at_the_thresholds():
    t = Thresholds()
    cs = [Candidate(str(p), str(p), [TERMS], decision="hint", review=["x"], judge=p) for p in (0.7, 0.5, 0.3)]
    resolve(cs, t)
    assert [c.decision for c in cs] == ["term", "hint", "hint"]


def test_real_wordfreq_agrees_with_the_values_the_defaults_were_chosen_from():
    assert english_zipf("affinal") < 2.0
    assert 2.0 <= english_zipf("teotihuacan") < 3.0
    assert 3.0 <= english_zipf("kinship") < 3.5
    assert 3.5 <= english_zipf("maya") < 4.0
    assert 4.0 <= english_zipf("temple") < 4.5
    assert english_zipf("the") >= 4.5
