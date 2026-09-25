"""Fetches candidates: MediaWiki category members and Datamuse triggers.

Every response is cached on disk by URL, so a rebuild after editing a recipe's
thresholds costs no requests, and the public APIs are asked politely: a
descriptive User-Agent, a pause between calls, and `maxlag` for MediaWiki.
"""

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from topic_packs.recipe import Source

USER_AGENT = "topic-packs/0.1 (https://github.com/lperezmo/topic-filter-mod; builds topic-filter term packs)"
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
WIKTIONARY_API = "https://en.wiktionary.org/w/api.php"
DATAMUSE_API = "https://api.datamuse.com/words"

NS_MAIN = 0
NS_CATEGORY = 14
RETRIES = 5


class FetchError(Exception):
    """A source that could not be read, after retries."""


class Http:
    """GETs JSON through an on-disk cache keyed by URL."""

    def __init__(
        self,
        cache_dir: Path,
        *,
        delay: float = 0.2,
        refresh: bool = False,
        offline: bool = False,
        opener: Callable[[urllib.request.Request, float], Any] = urllib.request.urlopen,
    ) -> None:
        self.cache_dir = cache_dir
        self.delay = delay
        self.refresh = refresh
        self.offline = offline
        self.opener = opener
        self.requests = 0
        self.cache_hits = 0
        self._last = 0.0

    def get_json(self, url: str) -> Any:
        path = self.cache_dir / "http" / (hashlib.sha256(url.encode()).hexdigest()[:40] + ".json")
        if path.exists() and not self.refresh:
            self.cache_hits += 1
            return json.loads(path.read_text(encoding="utf-8"))["body"]
        if self.offline:
            raise FetchError("a response is not cached and --offline is set")

        body = self._fetch(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"url": url, "body": body}, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
        return body

    def _fetch(self, url: str) -> Any:
        request = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
        )
        for attempt in range(RETRIES):
            wait = self.delay - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            self.requests += 1
            try:
                with self.opener(request, timeout=30) as response:
                    body = json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as err:
                if err.code not in (429, 500, 502, 503, 504) or attempt == RETRIES - 1:
                    raise FetchError(f"HTTP {err.code} from {_host(url)}") from None
                time.sleep(_retry_after(err.headers.get("Retry-After"), attempt))
                continue
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
                if attempt == RETRIES - 1:
                    raise FetchError(f"{_host(url)} failed: {err}") from None
                time.sleep(_retry_after(None, attempt))
                continue

            # MediaWiki answers a lagged replica with 200 and an error object.
            error = body.get("error") if isinstance(body, dict) else None
            if error and error.get("code") == "maxlag" and attempt < RETRIES - 1:
                time.sleep(_retry_after(None, attempt) + 5)
                continue
            if error:
                raise FetchError(f"{_host(url)} error: {error.get('code', 'unknown')}")
            return body
        raise FetchError(f"{_host(url)} kept failing")


def _host(url: str) -> str:
    return urllib.parse.urlsplit(url).netloc


def _retry_after(header: str | None, attempt: int) -> float:
    if header and header.isdigit():
        return min(float(header), 60.0)
    return min(2.0**attempt, 30.0)


def _mediawiki_url(api: str, params: dict[str, str]) -> str:
    return (
        f"{api}?{urllib.parse.urlencode({**params, 'format': 'json', 'formatversion': '2', 'maxlag': '5'})}"
    )


def category_members(http: Http, api: str, category: str, depth: int) -> list[str]:
    """Article titles in a category, with subcategories followed `depth` levels down."""
    titles: dict[str, None] = {}
    seen: set[str] = set()
    queue = [(category, 0)]
    while queue:
        name, level = queue.pop(0)
        if name in seen:
            continue
        seen.add(name)
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": f"Category:{name}",
            "cmlimit": "500",
            "cmtype": "page|subcat",
            "cmnamespace": f"{NS_MAIN}|{NS_CATEGORY}",
        }
        while True:
            body = http.get_json(_mediawiki_url(api, params))
            for member in body.get("query", {}).get("categorymembers", []):
                if member.get("ns") == NS_CATEGORY:
                    if level < depth:
                        queue.append((member["title"].split(":", 1)[1], level + 1))
                elif member.get("ns") == NS_MAIN:
                    titles.setdefault(member["title"])
            cont = body.get("continue", {}).get("cmcontinue")
            if not cont:
                break
            params = {**params, "cmcontinue": cont}
    return list(titles)


def search_categories(http: Http, api: str, query: str, limit: int = 20) -> list[str]:
    """Real category names for a search, to write into a recipe."""
    params = {"action": "query", "list": "search", "srnamespace": str(NS_CATEGORY), "srsearch": query}
    body = http.get_json(_mediawiki_url(api, {**params, "srlimit": str(limit)}))
    return [hit["title"].split(":", 1)[1] for hit in body.get("query", {}).get("search", [])]


def datamuse_triggers(http: Http, seed: str) -> list[str]:
    """Words statistically triggered by a seed word (Datamuse rel_trg)."""
    body = http.get_json(f"{DATAMUSE_API}?{urllib.parse.urlencode({'rel_trg': seed, 'max': '100'})}")
    return [item["word"] for item in body if isinstance(item, dict) and "word" in item]


def fetch(http: Http, source: Source) -> list[str]:
    """Everything one recipe source yields, before cleaning."""
    if source.kind == "wikipedia-category":
        return category_members(http, WIKIPEDIA_API, source.query, source.depth or 0)
    if source.kind == "wiktionary-category":
        return category_members(http, WIKTIONARY_API, source.query, source.depth or 0)
    if source.kind == "datamuse-rel-trg":
        return datamuse_triggers(http, source.query)
    raise ValueError(f"no fetcher for {source.kind}")
