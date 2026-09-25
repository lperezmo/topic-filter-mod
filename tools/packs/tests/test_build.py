"""End to end on canned sources: the pack contract, the report, and counts-only stdout."""

import json
from datetime import date

import pytest
from conftest import fake_zipf

from topic_packs import cli
from topic_packs.build import build, write_pack
from topic_packs.judge import Jev
from topic_packs.matcher import fold_term
from topic_packs.recipe import parse_recipe
from topic_packs.report import render

RECIPE = {
    "name": "demo",
    "description": "Test sites and their vocabulary.",
    "wikipedia": [{"category": "Test sites", "depth": 1}, {"category": "Nothing here"}],
    "wiktionary": [{"category": "en:Anthropology"}],
    "datamuse": ["archaeology"],
    "extra_terms": ["Giza"],
    "exclude": ["Xunantunich"],
}


def poster(body, api_key):
    words = {q["instructions"].split('"')[1]: qid for qid, q in body["questions"].items()}
    p = {"Maya": 0.5, "Baking Pot": 0.8, "Llama": 0.1}
    return {
        "answers": {qid: {"type": "noul", "noul": p.get(w, 0.5)} for w, qid in words.items()},
        "usage": {},
    }


@pytest.fixture
def built(tmp_path, fake_http):
    corpus = tmp_path / "corpus"
    for i in range(5):
        (corpus / f"p{i}").mkdir(parents=True)
        (corpus / f"p{i}" / "notes.md").write_text("pip install llama-cpp", encoding="utf-8")
    (corpus / "p0" / "trip.md").write_text("Tikal, twice: TIKAL", encoding="utf-8")
    judge = Jev("Test sites.", "k", tmp_path / "judge.json", post=poster)
    result = build(
        parse_recipe(RECIPE), fake_http, corpus=[corpus], judge=judge, zipf=fake_zipf, today=date(2026, 9, 24)
    )
    return result, corpus


def test_the_pack_follows_the_contract(built, tmp_path):
    result, _ = built
    path = tmp_path / "packs" / "demo.json"
    write_pack(result, path)
    pack = json.loads(path.read_text(encoding="utf-8"))

    assert list(pack) == ["name", "version", "description", "terms", "hints", "sources"]
    assert (pack["name"], pack["version"]) == ("demo", "2026.09.24")
    folded = [fold_term(t) for t in pack["terms"] + pack["hints"]]
    assert len(folded) == len(set(folded))
    assert pack["terms"] == sorted(pack["terms"], key=lambda t: (fold_term(t), t))
    assert pack["hints"] == sorted(pack["hints"], key=lambda t: (fold_term(t), t))
    assert path.read_text(encoding="utf-8").startswith('{\n  "name": "demo",')

    assert set(pack["terms"]) == {"Baking Pot", "Caracol", "Giza", "La Blanca", "Tikal", "affinal"}
    assert {"Maya", "Llama", "Temple", "kinship", "excavation", "epigraphy", "age set"} <= set(pack["hints"])
    for noise in ("AI", "ANT", "List of Maya sites", "2012 phenomenon", "Xunantunich", "the"):
        assert noise not in pack["terms"] + pack["hints"]

    assert pack["sources"][0] == {
        "kind": "wikipedia-category",
        "query": "Test sites",
        "depth": 1,
        "found": 11,
        "kept": 7,
    }
    assert pack["sources"][1]["found"] == 0
    assert pack["sources"][3] == {"kind": "datamuse-rel-trg", "query": "archaeology", "found": 3, "kept": 2}
    assert pack["sources"][4] == {"kind": "recipe", "query": "extra_terms", "found": 1, "kept": 1}


def test_the_dry_run_and_judge_decide_the_review_list(built):
    result, _ = built
    by_text = {c.text: c for c in result.candidates}
    assert by_text["Llama"].review == ["in 5 corpus files"]
    assert by_text["Llama"].judge == 0.1
    assert (by_text["Tikal"].decision, by_text["Tikal"].files, by_text["Tikal"].hits) == ("term", 1, 2)
    assert (by_text["Baking Pot"].decision, by_text["Baking Pot"].judge) == ("term", 0.8)
    assert [c.text for c in result.unsettled()] == ["Maya"]
    assert result.corpus_flagged == 1


def test_the_report_has_every_section_and_no_corpus_location(built):
    result, corpus = built
    text = render(result)
    for heading in ("## Summary", "## Sources", "## Terms (", "## Reviewed (", "## Hints (", "## Dropped ("):
        assert heading in text
    assert "| Llama | in 5 corpus files | 2.95 | 5 | 0.10 | hint (judge) |" in text
    assert "needs a human" in text
    assert str(corpus) not in text
    assert "notes.md" not in text and "p0" not in text
    assert "\u2014" not in text


def test_the_cli_prints_counts_and_never_terms(tmp_path, fake_http, monkeypatch, capsys):
    recipe_file = tmp_path / "demo.toml"
    recipe_file.write_text(
        'name = "demo"\ndescription = "Test sites."\n[[wikipedia]]\ncategory = "Test sites"\ndepth = 1\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(cli, "Http", lambda *a, **k: fake_http)
    out, report = tmp_path / "demo.json", tmp_path / "demo.md"
    code = cli.main(
        ["build", "demo", "--recipe", str(recipe_file), "--out", str(out), "--report", str(report)]
    )
    assert code == 0

    printed = capsys.readouterr().out
    pack = json.loads(out.read_text(encoding="utf-8"))
    assert pack["terms"]
    for word in pack["terms"] + pack["hints"]:
        assert word.lower() not in printed.lower()
    assert "terms" in printed and "wrote" in printed


def test_the_cli_names_a_bad_recipe(tmp_path, capsys):
    bad = tmp_path / "demo.toml"
    bad.write_text('name = "demo"\n', encoding="utf-8")
    assert cli.main(["build", "demo", "--recipe", str(bad)]) == 1
    assert "description must be" in capsys.readouterr().err
