from pathlib import Path

import pytest

from topic_packs.recipe import RecipeError, Source, load_recipe, parse_recipe

RECIPES = Path(__file__).resolve().parents[1] / "recipes"


def base(**over):
    return {"name": "demo", "description": "A demo.", "wikipedia": [{"category": "Maya sites"}], **over}


def test_fills_in_defaults_and_orders_sources():
    r = parse_recipe(
        base(
            wiktionary=[{"category": "en:Anthropology"}],
            datamuse=["archaeology"],
            extra_terms=["Tikal"],
            extra_hints=["dig"],
        )
    )
    assert r.sources == [
        Source("wikipedia-category", "Maya sites", "terms", 0),
        Source("wiktionary-category", "en:Anthropology", "hints", 0),
        Source("datamuse-rel-trg", "archaeology", "hints"),
        Source("recipe", "extra_terms", "terms"),
        Source("recipe", "extra_hints", "hints"),
    ]
    assert r.thresholds.term_below == 3.0


def test_thresholds_can_be_overridden():
    r = parse_recipe(base(thresholds={"term_below": 2.5, "corpus_files": 5}))
    assert (r.thresholds.term_below, r.thresholds.corpus_files) == (2.5, 5)


@pytest.mark.parametrize(
    ("over", "message"),
    [
        ({"name": "Bad Name"}, "name must be"),
        ({"description": " "}, "description must be"),
        ({"wikipedia": [{"category": "Category:Maya sites"}]}, "without the"),
        ({"wikipedia": [{"category": "X", "depth": 4}]}, "wikipedia[0].depth"),
        ({"wikipedia": [{"category": "X", "depth": True}]}, "wikipedia[0].depth"),
        ({"wikipedia": [{"category": "X", "role": "both"}]}, "wikipedia[0].role"),
        ({"wikipedia": [{"category": "X", "dept": 1}]}, "unknown keys: dept"),
        ({"wikipedia": {"category": "X"}}, "array of tables"),
        ({"datamuse": "archaeology"}, "datamuse must be an array"),
        ({"exclude": ["ok", ""]}, "exclude[1]"),
        ({"sources": []}, "unknown keys: sources"),
        ({"thresholds": {"term_below": "3"}}, "thresholds.term_below must be a number"),
        ({"thresholds": {"corpus_files": 2.5}}, "whole number"),
        ({"thresholds": {"term_below": 4.8}}, "term_below <= review_below"),
        ({"thresholds": {"judge_hint": 0.8}}, "judge_hint < judge_term"),
        ({"thresholds": {"typo": 1}}, "unknown keys: typo"),
        ({"wikipedia": []}, "at least one source"),
    ],
)
def test_rejects_bad_recipes_with_a_position(over, message):
    with pytest.raises(RecipeError, match=message.replace("[", r"\[").replace("]", r"\]")):
        parse_recipe(base(**over))


def test_every_committed_recipe_loads():
    paths = sorted(RECIPES.glob("*.toml"))
    assert paths
    for path in paths:
        assert load_recipe(path).name == path.stem
