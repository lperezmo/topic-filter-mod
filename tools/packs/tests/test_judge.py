import pytest

from topic_packs.judge import MODEL, Jev, JudgeError


class Poster:
    """Stands in for the decisions endpoint: answers from a table, records requests."""

    def __init__(self, probabilities, fail_on=None, drop=()):
        self.probabilities = probabilities
        self.fail_on = fail_on
        self.drop = set(drop)
        self.bodies = []

    def __call__(self, body, api_key):
        assert api_key == "test-key"
        self.bodies.append(body)
        if self.fail_on == len(self.bodies):
            raise JudgeError("HTTP 503 busy")
        answers = {}
        for qid, q in body["questions"].items():
            word = q["instructions"].split('"')[1]
            if word not in self.drop:
                answers[qid] = {"type": "noul", "noul": self.probabilities[word]}
        return {"model": "jev-test", "answers": answers, "usage": {"cost": 0.001, "input_tokens": 10}}


WORDS = {f"w{i}": i / 10 for i in range(10)}


def jev(tmp_path, poster, batch=4):
    return Jev("A topic.", "test-key", tmp_path / "judge.json", batch_size=batch, post=poster)


def test_asks_in_batches_of_noul_questions(tmp_path):
    poster = Poster(WORDS)
    j = jev(tmp_path, poster)
    assert j.judge(list(WORDS)) == WORDS
    assert [len(b["questions"]) for b in poster.bodies] == [4, 4, 2]
    body = poster.bodies[0]
    assert (body["model"], body["state"]) == (MODEL, "Topic: A topic.")
    assert body["questions"]["q0"]["type"] == "noul"
    assert (j.stats.requests, j.stats.asked, j.stats.model) == (3, 10, "jev-test")
    assert j.stats.cost == pytest.approx(0.003)


def test_answers_are_cached_across_runs(tmp_path):
    jev(tmp_path, Poster(WORDS)).judge(list(WORDS))
    poster = Poster(WORDS)
    again = jev(tmp_path, poster)
    assert again.judge(["w1", "w2"]) == {"w1": 0.1, "w2": 0.2}
    assert poster.bodies == []
    assert again.stats.cached == 2


def test_a_failed_request_keeps_the_answers_so_far(tmp_path):
    with pytest.raises(JudgeError, match="503") as err:
        jev(tmp_path, Poster(WORDS, fail_on=2)).judge(list(WORDS))
    assert err.value.answers == {f"w{i}": i / 10 for i in range(4)}
    poster = Poster(WORDS)
    jev(tmp_path, poster).judge(list(WORDS))
    assert sum(len(b["questions"]) for b in poster.bodies) == 6


def test_a_missing_answer_is_an_error(tmp_path):
    with pytest.raises(JudgeError, match="without some answers") as err:
        jev(tmp_path, Poster(WORDS, drop={"w1"})).judge(list(WORDS))
    assert "w1" not in err.value.answers
    assert err.value.answers["w0"] == 0.0


def test_batch_size_is_bounded_by_the_api(tmp_path):
    with pytest.raises(ValueError):
        jev(tmp_path, Poster(WORDS), batch=256)
