"""Offline fakes: canned API answers and a fixed word-frequency table."""

import urllib.parse

import pytest

from topic_packs.sources import Http

#: Zipf values in the spirit of wordfreq's; anything unlisted is rare.
ZIPF = {
    "tikal": 2.08,
    "baking": 3.92,
    "pot": 4.40,
    "baking pot": 3.80,
    "la": 5.0,
    "blanca": 2.5,
    "la blanca": 2.5,
    "caracol": 2.2,
    "maya": 3.87,
    "temple": 4.45,
    "the": 7.7,
    "affinal": 0.0,
    "kinship": 3.13,
    "alterity": 1.49,
    "age": 5.32,
    "set": 5.59,
    "age set": 5.13,
    "excavation": 3.46,
    "epigraphy": 1.82,
    "llama": 2.95,
    "egypt": 4.45,
    "sun": 4.97,
}


def fake_zipf(text: str) -> float:
    return ZIPF.get(text.lower(), 1.0)


class FakeHttp(Http):
    """Answers MediaWiki and Datamuse URLs from a table instead of the network."""

    def __init__(self, categories: dict[str, list[tuple[int, str]]], datamuse: dict[str, list[str]]) -> None:
        self.categories = categories
        self.datamuse = datamuse
        self.requests = 0
        self.cache_hits = 0
        self.urls: list[str] = []

    def get_json(self, url: str):
        self.urls.append(url)
        self.requests += 1
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        if "rel_trg" in query:
            return [{"word": w, "score": 100} for w in self.datamuse.get(query["rel_trg"], [])]
        members = self.categories.get(query["cmtitle"], [])
        return {"query": {"categorymembers": [{"ns": ns, "title": t} for ns, t in members]}}


@pytest.fixture
def fake_http() -> FakeHttp:
    return FakeHttp(
        categories={
            "Category:Test sites": [
                (0, "Tikal"),
                (0, "Baking Pot"),
                (0, "List of Maya sites"),
                (0, "La Blanca, Peten"),
                (0, "Caracol (Belize)"),
                (0, "Maya"),
                (0, "Temple"),
                (0, "Llama"),
                (0, "2012 phenomenon"),
                (14, "Category:Test sites in Belize"),
            ],
            "Category:Test sites in Belize": [(0, "Caracol"), (0, "Xunantunich")],
            "Category:en:Anthropology": [
                (0, "affinal"),
                (0, "AI"),
                (0, "ANT"),
                (0, "kinship"),
                (0, "age set"),
            ],
        },
        datamuse={"archaeology": ["excavation", "epigraphy", "the"]},
    )
