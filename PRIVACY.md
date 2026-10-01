# Privacy

Topic Filter runs entirely inside your Claude Code session. It has no
server, makes no network requests and sends nothing anywhere.

## What it reads

To do its job the mod reads, in memory, the text that is about to reach the
model: tool output, your prompts, CLAUDE.md and skill files, and the tool
calls the model makes. It replaces or drops the parts that match your
lists and passes the rest on unchanged. Nothing it reads is written to disk
by the mod.

## What it stores

Claude Code gives each plugin a small local store. Topic Filter keeps two
values there:

- `seed`: a random value, made once on this machine, that placeholder
  names are derived from. It is not derived from anything about you.
- `sidebar`: whether the sidebar was open.

Your settings (which packs are on, mode, match style, Start paused) live in
Claude Code's own settings file, like any plugin's. Your own term lists stay
in the topics file you wrote, where you put it.

## What it logs

`/topic-filter log` shows what was hidden this session. That log is kept in
memory and ends with the session; it is printed for you and not added to
the conversation. Claude Code copies `ui.log` lines into its debug log when
run with `--debug`, and other plugins that hook `ui.log` can see them; see
the README for the details.

## The pack builder

`tools/packs/` is a separate command line tool for building term packs from
public sources (Wikipedia, Wiktionary). It is not part of what runs in your
session. Its optional judge step asks you for an OpenRouter API key at the
prompt, uses it for that run only, and never reads it from the environment
or a file.

## Questions

Open an issue at https://github.com/lperezmo/topic-filter-mod/issues.
