"""Settles the review list with Jev, a decision model on OpenRouter.

Jev answers typed questions with calibrated probabilities instead of text. One
`noul` (yes/no) question per candidate asks whether the word, as it would turn
up in a developer's files, refers to the topic: the question a hidden term has
to pass. Several questions share one request; answers are cached on disk.
"""

import hashlib
import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

URL = "https://openrouter.ai/api/alpha/decisions"
MODEL = "~typesafe/jev-latest"
#: Part of every cache key: bump it when the wording below changes.
PROMPT_VERSION = "1"
#: Tested up to 200 questions per request; beyond ~24 answers drift up to 0.14 from small batches.
BATCH_SIZE = 20
MAX_BATCH = 255

CRITERIA = {
    "true": (
        "In almost any text where it appears, this refers to the topic: a place, culture, people, "
        "figure, object, or a technical term of the field"
    ),
    "false": (
        "This often means something else: an everyday word, a first name, a brand, product or "
        "software, or a place or thing outside the topic"
    ),
}


class JudgeError(Exception):
    """The judge could not answer. `answers` holds what it did answer, which is also cached."""

    def __init__(self, message: str, answers: dict[str, float] | None = None) -> None:
        super().__init__(message)
        self.answers = answers or {}


@dataclass
class JudgeStats:
    requests: int = 0
    cached: int = 0
    asked: int = 0
    seconds: float = 0.0
    cost: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""


Post = Callable[[dict[str, Any], str], dict[str, Any]]


def post_decisions(body: dict[str, Any], api_key: str) -> dict[str, Any]:
    """POSTs one decisions request. Errors carry the status and API message, never the key."""
    request = urllib.request.Request(
        URL,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "topic-packs",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        try:
            message = json.loads(err.read().decode("utf-8")).get("error", {}).get("message", "")
        except (ValueError, AttributeError):
            message = ""
        raise JudgeError(f"HTTP {err.code} {message}".strip()[:200]) from None
    except (urllib.error.URLError, TimeoutError, ValueError) as err:
        raise JudgeError(f"request failed: {err}") from None


class Jev:
    """Asks Jev about candidates for one topic, in batches, through a cache."""

    def __init__(
        self,
        description: str,
        api_key: str,
        cache_file: Path,
        *,
        batch_size: int = BATCH_SIZE,
        post: Post = post_decisions,
    ) -> None:
        if not 1 <= batch_size <= MAX_BATCH:
            raise ValueError(f"batch size must be from 1 to {MAX_BATCH}")
        self.state = f"Topic: {description.rstrip('.')}."
        self.api_key = api_key
        self.cache_file = cache_file
        self.batch_size = batch_size
        self.post = post
        self.stats = JudgeStats()
        self._cache: dict[str, float] = {}
        if cache_file.exists():
            self._cache = json.loads(cache_file.read_text(encoding="utf-8"))

    @staticmethod
    def question(candidate: str) -> dict[str, Any]:
        return {
            "type": "noul",
            "instructions": (
                f'A software developer\'s code, notes or command output contains "{candidate}". '
                "Does it most likely refer to the topic there?"
            ),
            "criteria": CRITERIA,
        }

    def _key(self, candidate: str) -> str:
        raw = json.dumps([MODEL, PROMPT_VERSION, self.state, candidate])
        return hashlib.sha256(raw.encode()).hexdigest()[:40]

    def judge(self, candidates: list[str]) -> dict[str, float]:
        """Probability per candidate that it refers to the topic.

        A failure raises JudgeError carrying the answers so far; they are
        cached too, so a rerun resumes where this one stopped.
        """
        answers: dict[str, float] = {}
        todo = []
        for c in dict.fromkeys(candidates):
            if self._key(c) in self._cache:
                answers[c] = self._cache[self._key(c)]
                self.stats.cached += 1
            else:
                todo.append(c)

        for i in range(0, len(todo), self.batch_size):
            batch = todo[i : i + self.batch_size]
            body = {
                "model": MODEL,
                "state": self.state,
                "questions": {f"q{j}": self.question(c) for j, c in enumerate(batch)},
            }
            started = time.perf_counter()
            try:
                reply = self.post(body, self.api_key)
            except JudgeError as err:
                raise JudgeError(str(err), answers) from None
            finally:
                self.stats.seconds += time.perf_counter() - started
                self.stats.requests += 1
            self._account(reply)

            got = reply.get("answers") or {}
            for j, c in enumerate(batch):
                p = (got.get(f"q{j}") or {}).get("noul")
                if isinstance(p, (int, float)) and not isinstance(p, bool):
                    answers[c] = self._cache[self._key(c)] = float(p)
                    self.stats.asked += 1
            self._save()
            if any(c not in answers for c in batch):
                raise JudgeError(f"batch {i // self.batch_size + 1} came back without some answers", answers)
        return answers

    def _account(self, reply: dict[str, Any]) -> None:
        usage = reply.get("usage") or {}
        self.stats.cost += float(usage.get("cost") or 0)
        self.stats.input_tokens += int(usage.get("input_tokens") or 0)
        self.stats.output_tokens += int(usage.get("output_tokens") or 0)
        self.stats.model = reply.get("model") or self.stats.model

    def _save(self) -> None:
        self.cache_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.cache_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._cache, indent=0, sort_keys=True), encoding="utf-8")
        tmp.replace(self.cache_file)
