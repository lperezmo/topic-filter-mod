# topic-filter-mod
Filter topics out of claude so you can focus on work that is allowed by Anthropic

`topic-filter` is a [Claude Mod](https://github.com/anthropics/claude-code/tree/main/mods)
(a Claude Code plugin built on function hooks) that hides chosen topics from
the model. You list terms; before the model reads anything, each term becomes a
stable placeholder name (`Teotihuacan` becomes `Teacup`), or the lines that
mention it disappear. You keep your repos, notes and memory as they are; the
session just cannot see those parts.

The motivating case: `gh repo list` shows repositories a session has no reason
to see. Tag them on GitHub, and they drop out of every listing the model reads.

> Function hooks are early access. This mod was built and tested against
> Claude Code 2.1.282, and the API may change between releases.

## Install

Function hooks must be on. Add this to the `env` block of
`~/.claude/settings.json` (or export it in your shell):

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Then add this repository as a marketplace and install the plugin:

```
claude plugin marketplace add lperezmo/topic-filter-mod
claude plugin install topic-filter@topic-filter-mod
```

Nothing happens until a topics file exists. Copy
[`examples/topics.example.json`](examples/topics.example.json) to
`~/.claude/topic-filter/topics.json` and edit it. To keep it elsewhere, set the
plugin's `configPath` option in `/config`.

Run `/topic-filter` in a session to see what it is doing (counts only, never
terms), and `/topic-filter reload` after editing the file or tagging repos.
The status line shows `topic-filter: on, N terms, M hidden`.

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

Matching ignores case and accents (`Teotihuacán` = `teotihuacan`), treats
spaces, hyphens and underscores as one separator (`secret repo` also finds
`secret-repo` and `secret_repo`), and takes plural and possessive endings
(`Mayas`, `Maya's`). Terms shorter than two characters are ignored.

A term keeps the same placeholder in every session. The names are derived from
the term and a random salt kept in the plugin's store, so memory files and the
prompt cache stay consistent, and the word list alone does not reveal the
mapping.

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
- **The topics file is off limits.** Tool calls naming it are refused, and
  anything read from it would be filtered anyway.
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

- Build term lists from a category: Wikidata from a few examples (the classes
  they share), WordNet, and a glossary from a local model, then pruned by a
  cheap classifier, producing a candidate list you review.
- An optional classifier for text that is about a topic without using a
  listed word (a local GLiNER server, or Jev), withholding whole chunks.
- Show you the real names in the transcript view while the model sees
  placeholders, and a `/topics` pane for adding terms without typing them into
  the transcript.

## License

GPL-3.0. See [LICENSE](LICENSE).
