// topic-filter: hides chosen topics from the model.
//
// Every place text enters the model's context is hooked, and the listed
// terms in it become placeholder names (or their lines are dropped) before
// the model reads it: tool results on their way up from core, the person's
// prompt, the system prompt's sections, the first message's context blocks
// (CLAUDE.md), injected attachments (mentioned files, reminders, classic
// hook context), skill text, tool descriptions, slash command output and
// deliveries from outside the session. `turn.step` carries no messages, so
// there is no single outgoing request to filter instead.
//
// On the way out, a tool call that uses a placeholder is refused, so the
// model cannot act on what it cannot see and never writes a placeholder over
// the real word in a file. A list marked `restore` puts the real term back
// instead.
//
// Every hook fails closed: when filtering throws or overruns, what it was
// filtering is withheld, never passed through.

import type { EngineInterface, On, PluginOptions, ToolCallResult } from 'claude-code'

import { ConfigError, parseConfig, type Config } from './config.ts'
import { fnv1a } from './placeholders.ts'
import { Filter, forEachString, newTally, noteFor, type Tally } from './redact.ts'

const COMMAND = 'topic-filter'
const DEFAULT_CONFIG = '.claude/topic-filter/topics.json'

/** How long a checked config stays trusted before the file is looked at again. */
const RECHECK_MS = 1000

/**
 * Tools whose input is the model talking to itself or to the person, never
 * to the world: a placeholder there is harmless, and a restore there would
 * hand the real term to a model (a subagent's prompt). Neither guard nor
 * restore touches them.
 */
const MODEL_FACING_TOOLS = new Set([
  'Agent',
  'Task',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  'ExitPlanMode',
  'SendMessage',
])

/** The context block that tells the model placeholders exist; stable, so the prompt cache holds. */
const EXPLAINER =
  "Some names in this session may be placeholders written by the user's topic-filter mod: capitalized " +
  'codenames such as Bubblegum or Kazoo2, or tags such as [hidden-3fa2c1]. Each stands for an item the ' +
  'user has hidden from this session, and lines about some hidden items are removed entirely. Treat a ' +
  'placeholder as an opaque name and do not guess what it stands for. Mentioning placeholders in replies ' +
  'is fine. A tool call (command, search, file edit) that uses one is refused, unless the note on the ' +
  'output it came from says that placeholder may be used.'

/** The topics file as last read, and the filter built from it. */
type Loaded = {
  key: string
  path: string
  config: Config | null
  filter: Filter | null
  /** Why the file could not be used; the filter kept is the last good one, if any. */
  error?: string
}

let loaded: Loaded | undefined
let loading: { key: string; promise: Promise<Loaded> } | undefined
let checkedAt = 0

/** Repositories found by GitHub topic, per list index, and a key that changes with them. */
let githubTerms = new Map<number, string[]>()
let githubKey = ''
let githubProblem: string | undefined

/** Items hidden since the session started, for the status line. */
let hiddenCount = 0

/** The `configPath` option; empty means the default under the home directory. */
let configured = ''

/** Files the model has read with something hidden, by pathKey. */
const filteredFiles = new Set<string>()

/** A path as a set key: one slash direction, one case. */
const pathKey = (path: string) => path.replace(/\\/g, '/').toLowerCase()

/** Whether what the model read lacks something a whole-file rewrite would lose. */
const hidesContent = (f: Filter, seen: Tally) => seen.dropped > 0 || [...seen.names].some(name => f.guarded.has(name))

async function pathOf($: EngineInterface): Promise<string> {
  // USERPROFILE first: on Windows it is where Claude Code keeps ~/.claude,
  // while HOME may be unset or a POSIX spelling from a Unix-like shell.
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  if (configured === '') return `${home}/${DEFAULT_CONFIG}`
  return configured.startsWith('~') ? home + configured.slice(1) : configured
}

async function saltOf($: EngineInterface): Promise<string> {
  const stored = await $.store.get('salt')
  if (typeof stored === 'string' && stored.length >= 16) return stored
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
  await $.store.set('salt', salt)
  return salt
}

/** The filter for the topics file as it is now, read again only when it changed. */
async function current($: EngineInterface): Promise<Loaded> {
  if (loaded !== undefined && Date.now() - checkedAt < RECHECK_MS) return loaded

  const path = await pathOf($)
  let key: string
  try {
    const stat = await $.fs.stat(path)
    key = `${path}|${stat.mtimeMs}|${stat.size}|${githubKey}`
  } catch {
    key = `${path}|missing`
  }
  checkedAt = Date.now()

  if (loaded?.key === key) return loaded
  if (loading?.key === key) return loading.promise

  const previous = loaded
  const promise = build($, path, key, previous)
  loading = { key, promise }
  try {
    loaded = await promise
  } finally {
    if (loading?.key === key) loading = undefined
  }

  // Cached answers were computed from the old file.
  if (previous !== undefined) {
    $.ui.invalidate('prompt.section')
    $.ui.invalidate('prompt.context')
    $.ui.invalidate('prompt.attachment')
    $.ui.invalidate('tool.describe')
  }
  showStatus($)
  return loaded
}

async function build($: EngineInterface, path: string, key: string, previous: Loaded | undefined): Promise<Loaded> {
  if (key.endsWith('|missing')) return { key, path, config: null, filter: null }

  try {
    const config = parseConfig(await $.fs.read(path))
    return { key, path, config, filter: new Filter(config, await saltOf($), githubTerms) }
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'the file could not be read'
    return { key, path, config: previous?.config ?? null, filter: previous?.filter ?? null, error: message }
  }
}

/** Reads the repositories each list names by GitHub topic; the last good answer stands in on failure. */
async function refreshGithub($: EngineInterface, config: Config): Promise<void> {
  const found = new Map<number, string[]>()
  const failed: string[] = []

  for (const [i, list] of config.lists.entries()) {
    if (list.githubTopic === undefined) continue
    const storeKey = `github:${list.githubTopic}`
    try {
      const run = await $.process.run(
        ['gh', 'repo', 'list', '--topic', list.githubTopic, '--limit', '1000', '--json', 'name'],
        { timeoutMs: 15_000 },
      )
      if (run.exitCode !== 0) throw new Error('gh failed')
      const names = (JSON.parse(run.stdout) as { name?: unknown }[])
        .map(repo => repo.name)
        .filter((name): name is string => typeof name === 'string')
      await $.store.set(storeKey, names)
      found.set(i, names)
    } catch {
      failed.push(list.githubTopic)
      const cached = await $.store.get(storeKey)
      if (Array.isArray(cached)) found.set(i, cached.filter((s): s is string => typeof s === 'string'))
    }
  }

  githubTerms = found
  githubKey = String(fnv1a(JSON.stringify([...found])))
  githubProblem = failed.length > 0 ? `gh could not list topic ${failed.join(', ')}; using the last list seen` : undefined
  checkedAt = 0
}

function statusText(): string {
  if (loaded === undefined || (loaded.filter === null && loaded.error === undefined)) return 'topic-filter: off (no topics file)'
  if (loaded.filter === null) return `topic-filter: BLOCKING, topics file error: ${loaded.error}`
  const base = `topic-filter: on, ${loaded.filter.termCount} terms, ${hiddenCount} hidden`
  if (loaded.error !== undefined) return `${base} (file error, using last good list: ${loaded.error})`
  return githubProblem === undefined ? base : `${base} (${githubProblem})`
}

function showStatus($: EngineInterface): void {
  $.ui.status(statusText())
}

function counted($: EngineInterface, tally: Tally): void {
  const n = tally.replaced + tally.dropped
  if (n === 0) return
  hiddenCount += n
  showStatus($)
}

function describe(l: Loaded): string {
  const lines = [statusText().replace(/^topic-filter: /, 'topic-filter is ')]
  lines.push(`Topics file: ${l.path}`)
  if (l.config !== null) {
    const drop = l.config.lists.filter(list => list.mode === 'drop-line').length
    lines.push(`${l.config.lists.length} lists (${drop} dropping lines), ${l.filter?.termCount ?? 0} distinct terms.`)
    if ((l.filter?.skippedTerms ?? 0) > 0) lines.push(`${l.filter?.skippedTerms} terms were too short to use.`)
  }
  return lines.join('\n')
}

export function register(on: On, options: PluginOptions) {
  configured = typeof options.configPath === 'string' ? options.configPath.trim() : ''

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Show what topic-filter is hiding (counts only); `reload` re-reads the topics file',
        argumentHint: '[reload]',
      })
    } catch {
      // The filter works without its command.
    }

    const first = await current($)
    if (first.config !== null && first.config.lists.some(l => l.githubTopic !== undefined)) {
      await refreshGithub($, first.config)
      await current($)
    }
    showStatus($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const l = await current($)
    const f = l.filter
    if (f === null) {
      if (l.error !== undefined) {
        return { deny: `topic-filter: tool calls are refused until the topics file is fixed (${l.error}).` }
      }
      return next(e)
    }

    const input = e as unknown as Record<string, unknown>
    if (mentionsPath(input, l.path)) {
      return { deny: 'topic-filter: that path holds the list of hidden topics, which this session may not read or change.' }
    }

    let call = e
    if (!MODEL_FACING_TOOLS.has(e.tool)) {
      const used = f.guardedIn(input)
      if (used.length > 0) {
        const names = used.join(', ')
        return {
          deny:
            `topic-filter: ${names} ${used.length === 1 ? 'is a placeholder for a hidden item' : 'are placeholders for hidden items'}. ` +
            'Hidden items cannot be used in commands, searches or file edits; leave them out or work around them.',
        }
      }
      const restored = f.restore(input)
      if (restored.changed) call = restored.value as typeof e
    }

    // A file read with lines dropped or terms hidden cannot be written back
    // whole: the model's copy lacks what it never saw. Edit changes only the
    // text it names, and fails if that text spans something hidden.
    if (e.tool === 'Write' && typeof e.file_path === 'string' && filteredFiles.has(pathKey(e.file_path))) {
      return {
        deny:
          'topic-filter: this file holds content hidden from this session, so overwriting it whole would delete ' +
          'that content. Use Edit to change specific parts instead.',
      }
    }

    const result = await next(call)
    const seen = newTally()
    const filtered = filterResult(f, result, seen)
    counted($, seen)
    if (e.tool === 'Read' && typeof e.file_path === 'string' && hidesContent(f, seen)) {
      filteredFiles.add(pathKey(e.file_path))
    }
    return filtered
  }).catch(($, e, next) => ({
    deny: next.called
      ? 'topic-filter: the tool ran, but its output is withheld because topic-filter failed while checking it.'
      : 'topic-filter: this call was refused because topic-filter failed while checking it.',
  }))

  on('prompt.submit', async ($, e, next) => {
    const f = (await current($)).filter
    if (f === null) return next(e)

    const tally = newTally()
    const text = f.text(e.text, tally, false)
    const context = e.context?.map(c => f.text(c, tally).value).filter(c => c.length > 0)
    if (tally.replaced === 0 && tally.dropped === 0) return next(e)

    counted($, tally)
    const note = f.informModel ? noteFor(tally, f.restorable) : undefined
    return next({ ...e, text: text.value, context: note === undefined ? context : [...(context ?? []), note] })
  }).catch(($, e, next) =>
    next.called ? undefined : { drop: 'topic-filter failed while checking this prompt, so it was not sent.' },
  )

  on('prompt.context', async ($, e, next) => {
    const f = (await current($)).filter
    if (f === null) return next(e)

    const r = await next(f.informModel ? { ...e, blocks: [...e.blocks, { name: 'topicFilter', text: EXPLAINER }] } : e)
    const tally = newTally()
    const blocks = r.blocks.map(b => ({ ...b, text: f.text(b.text, tally).value }))
    const instructionFiles = r.instructionFiles?.map(file => ({ ...file, content: f.text(file.content, tally).value }))
    counted($, tally)
    return instructionFiles === undefined ? { blocks } : { blocks, instructionFiles }
  }).catch(() => ({ blocks: [] }))

  on('prompt.section', async ($, e, next) => {
    const r = await next(e)
    const f = (await current($)).filter
    if (f === null || r.text === null) return r
    const tally = newTally()
    const text = f.text(r.text, tally)
    counted($, tally)
    return text.changed ? { text: text.value } : r
  }).catch(() => ({ text: null }))

  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    const f = (await current($)).filter
    if (f === null || r.text === null) return r
    const tally = newTally()
    const text = f.text(r.text, tally)
    counted($, tally)
    if (!text.changed) return r
    return { text: text.vanished ? null : text.value }
  }).catch(() => ({ text: null }))

  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    const f = (await current($)).filter
    if (f === null) return r
    const tally = newTally()
    const text = f.text(r.text, tally)
    counted($, tally)
    return text.changed ? { text: text.value } : r
  }).catch(() => ({ text: 'topic-filter failed while checking this skill, so its text is withheld.' }))

  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    const f = (await current($)).filter
    if (f === null) return r
    const text = f.text(r.description, newTally(), false)
    return text.changed ? { ...r, description: text.value } : r
  }).catch(() => ({ description: 'topic-filter failed while checking this description, so it is withheld.' }))

  on('session.receive', async ($, e, next) => {
    const f = (await current($)).filter
    if (f === null) return next(e)
    const tally = newTally()
    const text = f.text(e.text, tally, false)
    counted($, tally)
    return next(text.changed ? { ...e, text: text.value } : e)
  }).catch(($, e, next) =>
    next.called ? undefined : { consumed: 'topic-filter failed while checking this delivery.' },
  )

  on('command.run', async ($, e, next) => {
    if (e.command === COMMAND) {
      if (e.args.trim() === 'reload') {
        loaded = undefined
        const l = await current($)
        if (l.config !== null) await refreshGithub($, l.config)
      }
      const l = await current($)
      return { text: describe(l) }
    }

    const r = await next(e)
    const f = (await current($)).filter
    if (f === null || r.text === undefined) return r
    const tally = newTally()
    const text = f.text(r.text, tally)
    if (!text.changed) return r
    counted($, tally)
    const { ref: _ref, ...rest } = r
    return { ...rest, text: text.value }
  }).catch(() => ({ text: 'topic-filter failed while checking this output, so it is withheld.' }))
}

/**
 * Filters a tool's result for the model. `seen` counts what was hidden from
 * the text the model reads (`text`, which core maps from the record), not
 * from record fields it never sees (a Write's `originalFile`), so the note
 * and the status line describe the model's view.
 */
function filterResult(f: Filter, r: ToolCallResult, seen: Tally): ToolCallResult {
  if (r.deny !== undefined) {
    const text = f.text(r.deny, seen, false)
    return text.changed ? { deny: text.value } : r
  }

  // An errored call reaches the model as its error text; a deny carries a
  // rewritten one the same way.
  if (r.isError === true) {
    const text = f.text(r.text ?? '', seen, false)
    return text.changed ? { deny: text.value } : r
  }

  const record = f.value(r.result, newTally())
  if (typeof r.text === 'string') f.text(r.text, seen)
  const context = r.context?.map(c => f.text(c, seen))
  const contextChanged = context?.some(c => c.changed) ?? false

  if (!record.changed && !contextChanged) {
    // A term in `text` that the record does not hold came from the mapper,
    // so filtering the record cannot remove it: send the filtered text as an
    // error instead.
    if (typeof r.text === 'string' && f.hasTerm(r.text)) return { deny: f.text(r.text, newTally(), false).value }
    return r
  }

  const kept = (context ?? []).map(c => c.value).filter(c => c.length > 0)
  const note = f.informModel ? noteFor(seen, f.restorable) : undefined
  const all = note === undefined ? kept : [...kept, note]
  // Without `ref`, core maps the filtered record for the model afresh.
  return all.length > 0 ? { result: record.value, context: all } : { result: record.value }
}

/** Whether a tool call names the topics file (best effort: a name match, not a sandbox). */
function mentionsPath(input: Record<string, unknown>, path: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase()
  const full = norm(path)
  const tail = full.split('/').slice(-2).join('/')
  let found = false
  forEachString(input, s => {
    const n = norm(s)
    if (n.includes(full) || n.includes(tail)) found = true
  })
  return found
}
