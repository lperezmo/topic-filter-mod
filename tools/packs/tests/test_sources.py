import io
import json
import urllib.error
import urllib.parse

import pytest

from topic_packs import sources
from topic_packs.sources import (
    WIKIPEDIA_API,
    FetchError,
    Http,
    category_members,
    datamuse_triggers,
    search_categories,
)


class Opener:
    """Stands in for urlopen: answers by the request's query string, counts calls."""

    def __init__(self, answer):
        self.answer = answer
        self.calls: list[str] = []

    def __call__(self, request, timeout):
        self.calls.append(request.full_url)
        assert "topic-filter-mod" in request.get_header("User-agent")
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(request.full_url).query))
        result = self.answer(query, len(self.calls))
        if isinstance(result, Exception):
            raise result
        return io.BytesIO(json.dumps(result).encode())


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(sources.time, "sleep", lambda s: None)


def members(*items, cont=None):
    body = {"query": {"categorymembers": [{"ns": ns, "title": t} for ns, t in items]}}
    if cont:
        body["continue"] = {"cmcontinue": cont, "continue": "-||"}
    return body


def tree(query, _):
    title, cont = query["cmtitle"], query.get("cmcontinue")
    assert query["maxlag"] == "5"
    if title == "Category:Top" and cont is None:
        return members((0, "A"), (14, "Category:Sub"), cont="page2")
    if title == "Category:Top":
        return members((0, "B"), (14, "Category:Top"))
    if title == "Category:Sub":
        return members((0, "C"), (0, "A"), (14, "Category:Deep"))
    if title == "Category:Deep":
        return members((0, "D"))
    raise AssertionError(title)


def test_pages_through_members_and_follows_subcategories_to_depth(tmp_path):
    http = Http(tmp_path, delay=0, opener=Opener(tree))
    assert category_members(http, WIKIPEDIA_API, "Top", 0) == ["A", "B"]
    assert category_members(http, WIKIPEDIA_API, "Top", 1) == ["A", "B", "C"]
    assert category_members(http, WIKIPEDIA_API, "Top", 2) == ["A", "B", "C", "D"]


def test_responses_are_cached_on_disk_by_url(tmp_path):
    opener = Opener(tree)
    category_members(Http(tmp_path, delay=0, opener=opener), WIKIPEDIA_API, "Top", 1)
    calls = len(opener.calls)
    again = Http(tmp_path, delay=0, opener=opener)
    assert category_members(again, WIKIPEDIA_API, "Top", 1) == ["A", "B", "C"]
    assert len(opener.calls) == calls
    assert again.cache_hits == calls


def test_offline_refuses_to_fetch(tmp_path):
    with pytest.raises(FetchError, match="offline"):
        Http(tmp_path, offline=True, opener=Opener(tree)).get_json(WIKIPEDIA_API + "?x=1")


def test_retries_maxlag_and_server_errors(tmp_path):
    def flaky(query, n):
        if n == 1:
            return {"error": {"code": "maxlag", "info": "lagged"}}
        if n == 2:
            return urllib.error.HTTPError("u", 503, "busy", {"Retry-After": "1"}, None)
        return members((0, "A"))

    opener = Opener(flaky)
    assert category_members(Http(tmp_path, delay=0, opener=opener), WIKIPEDIA_API, "Top", 0) == ["A"]
    assert len(opener.calls) == 3


def test_a_client_error_is_not_retried(tmp_path):
    opener = Opener(lambda q, n: urllib.error.HTTPError("u", 404, "missing", {}, None))
    with pytest.raises(FetchError, match="HTTP 404"):
        Http(tmp_path, delay=0, opener=opener).get_json(WIKIPEDIA_API + "?x=1")
    assert len(opener.calls) == 1


def test_search_and_datamuse(tmp_path):
    def answer(query, _):
        if "srsearch" in query:
            assert query["srnamespace"] == "14"
            return {"query": {"search": [{"title": "Category:Maya sites"}]}}
        assert (query["rel_trg"], query["max"]) == ("archaeology", "100")
        return [{"word": "excavation", "score": 1}, {"word": "epigraphy", "score": 1}]

    http = Http(tmp_path, delay=0, opener=Opener(answer))
    assert search_categories(http, WIKIPEDIA_API, "maya sites") == ["Maya sites"]
    assert datamuse_triggers(http, "archaeology") == ["excavation", "epigraphy"]
