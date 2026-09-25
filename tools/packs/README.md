# topic-packs

Builds the built-in packs in [`packs/`](../../packs): ready-made term lists for
one general topic. A recipe names public sources; the builder fetches them,
cleans and deduplicates the titles with the mod's own matcher, sorts them into
terms and hints by word frequency, checks the terms against your own files, and
can ask a judge about the doubtful ones. A human then reads the report.

## Build

```
uv run --project tools/packs topic-packs build anthropology --corpus D:\Python --judge jev
uv run --project tools/packs pytest
```

This writes `packs/anthropology.json` and `tools/packs/reports/anthropology.md`.
The command prints counts only, never terms: a pack may cover something a model
session reading the output should not see. Review the terms in the report.

Every HTTP response and judge answer is cached in `tools/packs/.cache/`
(gitignored), so rebuilding after a recipe edit is quick. `--refresh` refetches;
`--offline` fails rather than fetch.

## Recipes

`tools/packs/recipes/<name>.toml`, checked strictly (unknown keys are errors):

```toml
name = "anthropology"                 # lowercase letters, digits, hyphens
description = "One sentence on what the pack covers."

datamuse = ["archaeology"]            # seeds for Datamuse rel_trg; always hints
extra_terms = ["Olmec"]               # always terms (use for names sources only give as plurals)
extra_hints = ["dig site"]            # always hints
exclude = ["Aztec"]                   # never in the pack, matched by folded form

[[wikipedia]]
category = "Maya sites"               # exact name, no "Category:" prefix
depth = 1                             # subcategory levels to follow, 0-3 (default 0)
role = "terms"                        # "terms" (default) or "hints"

[[wiktionary]]
category = "en:Anthropology"          # topic categories; role defaults to "hints"

[thresholds]                          # optional; defaults shown
term_below = 3.0
review_below = 4.0
drop_from = 4.5
common_word = 3.5
rare_vocabulary = 2.0
corpus_files = 3
judge_term = 0.7
judge_hint = 0.3
```

Category names must match exactly. Find them with
`topic-packs categories "maya sites"` (add `--wiktionary` for Wiktionary); this
one prints names, so run it yourself rather than in a filtered session.

## How candidates are sorted

Frequencies are wordfreq Zipf values (0-8; 3 is about once per million words),
taking the commoner of the spelling as written and as folded.

- **Names** (from `terms` sources): below 3.0 a term; 3.0-4.0 review; 4.0-4.5 a
  hint; 4.5 and up dropped. The review band reaches 4.0 because the core names
  sit there (`maya` 3.87, `aztec` 3.10) and are exactly the ones that also mean
  a product or a person.
- **Multi-word names** go by their words, since wordfreq scores a phrase about
  as rare as its rarest word. One word under 3.5 makes a term (`Pyramids of
  Giza`); all words common sends it to review (`Baking Pot`, a real site);
  a phrase scoring 4.5 or more is dropped.
- **Vocabulary** (Wiktionary, `hints` sources): a hint, and also a term when
  rarer than 2.0 (`affinal`, `dendrochronology`), since jargon that rare is
  topic-specific and harmless to hide. Datamuse only ever gives hints: its
  associations are loose.
- Cleaning drops list and outline pages, namespaces, years, affixes, 1-2
  character items, all-caps items of 4 characters or fewer (`AI`, `ANT`) and
  titles over 5 words, strips `(disambiguators)` and `, Region` qualifiers, and
  merges spellings the mod treats as one, keeping the one with accents or
  capitals.

Reviewed candidates default to hints. The dry run and the judge can settle them.

## Dry run

`--corpus PATH` (repeatable) should be a folder of your ordinary work. Terms
found there in more than `corpus_files` distinct files go to review: in normal
work they are likely false positives. Text files only (`.md .py .ts .json ...`),
skipping `node_modules`, `.git`, `.venv`, build folders and files over 1 MB.
Past 20,000 files it samples evenly across the whole walk.

Any checkout of this repository is skipped automatically (a directory whose
`.claude-plugin/plugin.json` has `"name": "topic-filter"`): its packs and
reports hold the very terms being counted. `--exclude PATH` (repeatable) skips
more. The report records counts per term, never paths or file names.

## Judge

`--judge jev` asks [Jev](https://openrouter.ai/~typesafe/jev-latest), a decision
model on OpenRouter, about the review list only. Each candidate is one `noul`
question: does it, as found in a developer's code, notes or command output,
most likely refer to the topic? At 0.7 or above it becomes a term, at 0.3 or
below a hint; in between it stays a hint marked "needs a human" in the report.

The key comes from `OPENROUTER_API_KEY`, or from `--env-file` (default
`D:\Python\jev-test\.env`) at run time. Questions go 20 to a request
(`--judge-batch`; tested to 200, but answers drift up to 0.14 past about 24).
The anthropology pack's first build cost $0.00045 for 85 questions.
Answers are cached by model, prompt version and wording.

## The report

`reports/<name>.md`: summary counts and thresholds, sources with found/kept
counts, then every term (source, Zipf, corpus files and hits), the review list
(why, judge probability, decision), hints, and the first 200 drops with their
reasons. To change the pack, edit the recipe (`exclude`, `extra_terms`,
thresholds) and rebuild; do not edit the pack file by hand.
