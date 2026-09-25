import json

from topic_packs.dryrun import MAX_FILE_BYTES, dry_run, is_topic_filter_checkout
from topic_packs.matcher import Matcher


def matcher_of(*terms):
    m = Matcher()
    for t in terms:
        m.add(t)
    return m


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def checkout(root, name="topic-filter"):
    write(root / ".claude-plugin" / "plugin.json", json.dumps({"name": name}))
    write(root / "packs" / "demo.json", '{"terms": ["Tikal"]}')


def test_counts_hits_and_distinct_files(tmp_path):
    write(tmp_path / "a.md", "Tikal and tikal")
    write(tmp_path / "src" / "b.py", "# TIKAL\n")
    write(tmp_path / "src" / "c.ts", "nothing here")
    run = dry_run(matcher_of("Tikal", "Giza"), [tmp_path], [])
    assert (run.files, run.hits["tikal"], run.files_with["tikal"]) == (3, 3, 2)
    assert run.hits["giza"] == 0


def test_skips_build_dirs_other_suffixes_big_and_binary_files(tmp_path):
    for skipped in ("node_modules", ".git", ".venv", "dist", "__pycache__"):
        write(tmp_path / skipped / "x.md", "Tikal")
    write(tmp_path / "image.png", "Tikal")
    write(tmp_path / "big.txt", "Tikal " + "x" * MAX_FILE_BYTES)
    (tmp_path / "nul.txt").write_bytes(b"Tikal\0\0")
    write(tmp_path / "kept.md", "Tikal")
    run = dry_run(matcher_of("Tikal"), [tmp_path], [])
    assert (run.files, run.hits["tikal"]) == (1, 1)


def test_always_skips_checkouts_of_topic_filter(tmp_path):
    checkout(tmp_path / "topic-filter-mod")
    checkout(tmp_path / "topic-filter-mod-packs")
    checkout(tmp_path / "other-plugin", name="something-else")
    write(tmp_path / "notes.md", "Tikal")
    run = dry_run(matcher_of("Tikal"), [tmp_path], [])
    assert run.skipped_checkouts == 2
    assert run.files_with["tikal"] == 2  # notes.md and other-plugin/packs/demo.json
    assert is_topic_filter_checkout(tmp_path / "topic-filter-mod")
    assert not is_topic_filter_checkout(tmp_path / "other-plugin")


def test_a_corpus_root_that_is_a_checkout_is_skipped_too(tmp_path):
    checkout(tmp_path)
    assert dry_run(matcher_of("Tikal"), [tmp_path], []).files == 0


def test_exclude_skips_folders_and_files(tmp_path):
    write(tmp_path / "private" / "a.md", "Tikal")
    write(tmp_path / "one.md", "Tikal")
    write(tmp_path / "two.md", "Tikal")
    run = dry_run(matcher_of("Tikal"), [tmp_path], [tmp_path / "private", tmp_path / "one.md"])
    assert (run.files, run.files_with["tikal"]) == (1, 1)


def test_past_the_cap_files_are_sampled_across_the_whole_walk(tmp_path):
    for project in ("a", "b", "c", "d"):
        for i in range(5):
            write(tmp_path / project / f"{i}.md", project)
    run = dry_run(matcher_of("aa"), [tmp_path], [], max_files=4)
    assert (run.files_found, run.files) == (20, 4)
