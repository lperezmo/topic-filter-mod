# topic-filter-mod
Filter topics out of claude so you can focus on work that is allowed by Anthropic

`topic-filter` is a [Claude Mod](https://github.com/anthropics/claude-code/tree/main/mods)
(a Claude Code plugin built on function hooks) that hides chosen topics from
the model. Before the model reads anything, each listed term becomes a stable
placeholder (`Teotihuacan` becomes `Teacup`), or the lines that mention it
disappear. Your repos, notes and memory stay as they are.

## Install

**1. Turn on function hooks.** They are early access. Add this to
`~/.claude/settings.json` (merge the key into an existing `env` block if you
have one):

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

**2. Install the plugin.** This repository is its own marketplace:

```
claude plugin marketplace add lperezmo/topic-filter-mod
claude plugin install topic-filter@topic-filter-mod
```

Or from inside Claude Code: `/plugin marketplace add lperezmo/topic-filter-mod`,
then `/plugin install topic-filter@topic-filter-mod`.

**3. Choose what to hide.** Run `/config` and type `topic-filter` to find the
plugin's rows. Enter or Space flips a switch or edits a field:

| Setting | Default | What it does |
| --- | --- | --- |
| Hide repos tagged on GitHub | on | Your repos with a topic below drop out of everything Claude reads |
| GitHub topics | `claude-hidden` | Comma-separated topics that mark a repo as hidden |
| Hide anthropology, biology, chemistry, cybersecurity, genetics | off | One switch per [built-in pack](#topic-packs) |
| Other packs | empty | Names of [your own packs](#topic-packs), comma-separated |
| Extra words to hide | empty | Comma-separated words or names; kept in secure storage, not in `settings.json` |
| Topics file (advanced) | empty | Where [the topics file](#the-topics-file) lives, if you want one |

**Extra words to hide** is kept secret, so `/config` does not list it: set it
in `/plugin`: Installed, then `topic-filter`, then configure it. That screen
shows every setting as a text box; there, a switch takes the word `true` or
`false` (a `y` is saved as false).

What you type in either place goes to the plugin, never into the
conversation. A change applies right away, no restart needed. To hide a repo:

```
gh repo edit OWNER/REPO --add-topic claude-hidden
```

then `/topic-filter reload` in a running session.

**4. Restart Claude Code** once after installing: sessions that were already
running do not load the plugin. The status line then shows
`on, N terms, M hidden`, and `/topic-filter` shows what is hidden and where
each part comes from (counts only, shown to you only).

The [topics file](#the-topics-file) is optional. Use it for what the settings
cannot express: drop-line or restore modes for your own words, several lists,
`exclude`. Write it yourself in an editor rather than asking Claude, since it
holds the words you are hiding. Its lists add to the settings'.

> Built and tested against Claude Code 2.1.282. The function hooks API may
> change between releases.

## Update

Claude Code does not update plugins from third-party marketplaces on its own
unless you turn that on. Pick one:

- **Automatic (recommended).** Once, in Claude Code: `/plugin`, then
  Marketplaces, then `topic-filter-mod`, then enable auto-update. New versions
  install when Claude Code starts.
- **By hand**, whenever you want the latest:

  ```
  claude plugin marketplace update topic-filter-mod
  claude plugin update topic-filter@topic-filter-mod
  ```

Either way, restart Claude Code afterwards; running sessions keep the old
version. `claude plugin list` shows the version you have. Updates never touch
your topics file or your own packs in `~/.claude/topic-filter/`.

To remove it: `claude plugin uninstall topic-filter@topic-filter-mod`. Your
topics file stays until you delete it.

## Using it

The motivating case: `gh repo list` shows repositories a session has no reason
to see. [Tag them on GitHub](#hiding-repositories-without-deleting-them), and
they drop out of every listing the model reads.

Run `/topic-filter` in a session to see each list and where its terms come
from, `/topic-filter packs` to see every topic pack and which lists use it,
and `/topic-filter reload` after tagging repos. Both show counts, never terms,
and are shown to you only: they name packs and lists, which would tell Claude
what is being hidden. Edits to the topics file and packs are picked up on
their own.

## The topics file

```json
{
  "placeholder": "codename",
  "informModel": true,
  "lists": [
    { "name": "hidden-repos", "mode": "drop-line", "githubTopic": "claude-hidden", "terms": ["my-private-experiment"] },
    { "name": "anthropology", "terms": ["Teotihuacan", "Chichen Itza", "Maya", "Pyramids of Giza"] },
    { "name": "email-contacts", "restore": true, "terms": ["Ada Lovelace"] }
  ]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `placeholder` | `codename` | `codename` gives each term a capitalized word (`Bubblegum`, `Kazoo2`). `tag` gives `[hidden-3fa2c1]`. |
| `informModel` | `true` | Tell the model that placeholders exist and how to treat them. Without it the model tends to treat `Bubblegum` as a real name and go looking for it. |
| `lists[].name` | `list N` | A label for you. It never reaches the model. |
| `lists[].terms` | `[]` | The terms to hide. |
| `lists[].mode` | `replace` | `replace` swaps each term for its placeholder. `drop-line` removes every line that mentions a term; in JSON (`gh ... --json`, MCP results) the whole array item goes. A typed prompt always gets placeholders, never lost lines. |
| `lists[].match` | `word` | `word` matches whole words only. `substring` matches inside words too (`maya` in `Mayapan`). |
| `lists[].restore` | `false` | When the model uses this list's placeholder in a tool call, write the real term back instead of refusing. For drafting text that must contain real names the model should not read. |
| `lists[].githubTopic` | none | At session start, every repository of yours tagged with this GitHub topic joins the list (`gh repo list --topic`). The last good answer is used if `gh` fails. |
| `lists[].pack` | none | A [topic pack](#topic-packs) whose terms join the list. |
| `lists[].exclude` | `[]` | Terms to leave out of the list, whatever brought them in (a pack, a GitHub topic, `terms`). Matched the same forgiving way as terms. |

Matching ignores case and accents (`Teotihuacán` = `teotihuacan`), treats
spaces, hyphens and underscores as one separator (`secret repo` also finds
`secret-repo` and `secret_repo`), and takes plural and possessive endings
(`Mayas`, `Maya's`). Terms shorter than two characters are ignored.

A term keeps the same placeholder in every session. The names are derived from
the term and a random salt kept in the plugin's store, so memory files and the
prompt cache stay consistent, and the word list alone does not reveal the
mapping.

### Topic packs

A pack is a ready-made term list for one topic, so you do not have to type
every name yourself. Point a list at one:

```json
{ "lists": [{ "name": "anthropology", "pack": "anthropology", "exclude": ["Maya"], "terms": ["my extra word"] }] }
```

The list keeps its own `mode`, `match` and `restore`, `exclude` drops pack
terms you do not want hidden, and `terms` adds your own. `/topic-filter packs`
lists every pack with what it covers and its counts (never its terms), and
marks which of your lists use it.

A pack name that does not exist is never ignored quietly, since that would
hide nothing while looking set up. Tool calls pause, the status line and a
toast name the missing pack, and `/topic-filter` suggests the closest real
one ("Did you mean paleontology?") and lists what is available. Claude only
hears that the settings have a problem, not which pack.

**Built-in packs** ship in this repository's [`packs/`](packs) folder:

| Pack | Terms | Covers |
| --- | --- | --- |
| `anthropology` | 2,167 | Ancient Mesoamerican, Andean and Egyptian sites, civilizations, rulers and deities; anthropology and archaeology vocabulary |
| `biology` | 270 | Molecular biology techniques, cellular processes, anatomical terms |
| `chemistry` | 940 | Chemical elements, named reactions, functional groups, laboratory equipment |
| `cybersecurity` | 312 | Named malware, computer worms and hacker groups; security and cryptography vocabulary |
| `genetics` | 2,591 | Genetic disorders and syndromes; genetics and heredity vocabulary |

They are built by the script in [`tools/packs/`](tools/packs) from Wikipedia
and Wiktionary categories, word-frequency data and a dry run against ordinary
code, with a review report per pack in `tools/packs/reports/`.

**Your own packs** go in `~/.claude/topic-filter/packs/<name>.json`. A pack
there replaces a built-in one of the same name, so to customize a built-in
pack, copy it there and edit the copy. Never edit the plugin's own folder:
Claude Code replaces it on every update. The format:

```json
{
  "name": "my-topic",
  "description": "What it covers.",
  "terms": ["Hidden on sight", "Another one"],
  "hints": ["loose", "related", "words"]
}
```

Only `terms` hide anything today; `hints` are kept for a later version that
takes a closer look at paragraphs mentioning them. Editing a pack file takes
effect on the next tool call, no restart needed.

### Hiding repositories without deleting them

```
gh repo edit lperezmo/some-repo --add-topic claude-hidden
```

With a list whose `githubTopic` is `claude-hidden` and `mode` is `drop-line`,
that repository vanishes from `gh repo list`, `gh api` JSON, GitHub MCP
results, paths, file contents and memory. Remove the topic to bring it back.
The lookup runs through the mod itself, so the list of hidden names never
enters the transcript.

## What it covers

Text reaches the model through many doors, and there is no single outgoing
request to filter (`turn.step` carries a message count, not the messages). So
every door is hooked:

| What the model reads | Event |
| --- | --- |
| Tool results: Bash, Read, Grep, Glob, WebFetch, MCP tools, subagent answers, errors | `tool.call`, on the way up |
| Your typed prompt | `prompt.submit` |
| CLAUDE.md and the other first-message context blocks | `prompt.context` |
| System prompt sections, memory included | `prompt.section` |
| Mentioned files, reminders, context added by classic hooks | `prompt.attachment` |
| Skill text, tool descriptions, slash command output | `skill.prompt`, `tool.describe`, `command.run` |
| Remote Control and peer deliveries | `session.receive` |

Going the other way:

- **Guard.** A tool call that uses a placeholder is refused, so the model
  cannot act on what it cannot see, and never writes `Bubblegum` into a file
  where the real word was. Subagent prompts, todos and questions to you are
  exempt, since they are the model talking to itself or to you.
- **No blind overwrites.** Once the model has read a file with something
  hidden, a whole-file `Write` to it is refused: its copy lacks what it never
  saw. `Edit` still works, and fails safely if its text spans something hidden.
- **The topics file is off limits.** It names your lists and packs, which
  say what is hidden even where the words themselves are filtered. Reading,
  editing or writing it is refused, as is any shell command that names it.
  Writing another file that merely mentions its path (docs, a script) is fine.
- **Fails closed.** If filtering throws or runs out of time, what it was
  filtering is withheld, never passed through. A broken topics file keeps the
  last good list, or refuses tool calls until it is fixed, and the status line
  says so.

## Limits

Read these before relying on it.

- **Placeholders hide words, not meaning.** "Teacup, the pyramid city north of
  Mexico City" gives it away. Use `drop-line` for items whose surroundings
  identify them.
- **Only text is filtered.** Text inside images and PDFs gets through.
- **Encodings get through.** Base64, hex, a word split across lines, or a file
  whose accents were saved in the wrong encoding (`Teotihuac?n`) does not
  match. In testing, the model reconstructed a word from exactly that last
  case. This is a filter, not a security boundary.
- **Your local transcript keeps what you typed.** The model receives your
  prompt with placeholders, but the engine's queue record in the session file
  on disk holds the text as typed.
- **Shell rewrites of filtered files are not caught.** `cat > notes.md` built
  from a filtered read loses the hidden lines. Only `Write` is refused.
- **Sessions from before the mod was on** already hold the raw terms.
- **Other plugins** that hook `tool.call` beneath this one see raw results.
- **Your settings are readable.** The pack switches and GitHub topics you set
  in `/plugin` are stored in `~/.claude/settings.json`, which Claude can read,
  so they show which topics you hide (the extra words are in secure storage).
  Only the topics file is guarded.

## Development

```
claude plugin validate .claude-plugin/plugin.json   # what the module hooks and calls
claude plugin test .                                 # tests/*.test.ts against the engine
```

Types: run `/plugin-types` in a session in this folder. It writes the engine's
declarations for your build to `.claude/types/`, which is gitignored: they are
Anthropic's, and `claude-code-mcp.d.ts` lists your own MCP tools. Then
`tsc -p tsconfig.json` type-checks the module (`bunx -p typescript tsc -p
tsconfig.json` if TypeScript is not installed).

To try it in a real session without installing, point a settings file at a
test topics file:

```json
{ "pluginConfigs": { "topic-filter": { "options": { "configPath": "/path/to/topics.json" } } } }
```

```
claude --plugin-dir . --settings that-file.json
```

After a session, search its transcript under `~/.claude/projects/` for the
raw terms: none should appear outside the `queue-operation` record of a prompt
you typed.

## Roadmap

- More built-in packs, and a larger codename word list so big packs get fewer
  numbered placeholders (`Teacup14`).
- An optional classifier for text that is about a topic without using a
  listed word (a local GLiNER server, or Jev), withholding whole chunks.
- Show you the real names in the transcript view while the model sees
  placeholders, and a `/topics` pane for adding terms without typing them into
  the transcript.

## License

GPL-3.0. See [LICENSE](LICENSE).
