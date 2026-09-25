import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import type { Summary } from '../hooks/log.ts'
import { sidebarView, SIDEBAR_ID } from '../hooks/sidebar.tsx'

// The world beneath the plugin: a home directory, a topics file (or none),
// pack files (the person's own and built-in ones), a store, and a status
// line that goes nowhere.

const HOME = '/home/tester'
const TOPICS_PATH = `${HOME}/.claude/topic-filter/topics.json`
const USER_PACKS = `${HOME}/.claude/topic-filter/packs`

/** Pack files by name: the person's own folder, and the plugin's `packs/`. */
type Packs = { mine?: Record<string, string>; builtIn?: Record<string, string> }

const pack = (terms: string[], hints: string[] = []) => JSON.stringify({ name: 'x', terms, hints })

/**
 * The file a path names in this world, or undefined. The host resolves a
 * path before hooks see it (on Windows, `/home/x` is `D:\home\x`), so paths
 * are compared by their end.
 */
function fileAt(path: string, topics: string | null, packs: Packs): string | undefined {
  const p = path.replace(/\\/g, '/')
  if (p.endsWith(TOPICS_PATH)) return topics ?? undefined
  const name = /\/packs\/([a-z0-9-]+)\.json$/.exec(p)?.[1]
  if (name === undefined) return undefined
  return p.includes(`${USER_PACKS}/`) ? packs.mine?.[name] : packs.builtIn?.[name]
}

/** The pack files a folder lists in this world. */
function filesIn(path: string, packs: Packs): string[] | undefined {
  const p = path.replace(/\\/g, '/').replace(/\/$/, '')
  if (p.endsWith(USER_PACKS)) return Object.keys(packs.mine ?? {})
  if (p.endsWith('/packs')) return Object.keys(packs.builtIn ?? {})
  return undefined
}

const TOPICS = JSON.stringify({
  lists: [
    { name: 'places', terms: ['Teotihuacan', 'Pyramids of Giza'] },
    { name: 'repos', mode: 'drop-line', terms: ['secret-repo'] },
  ],
})

const GH_LIST = 'lperezmo/public-repo\tA public one\tpublic\nlperezmo/secret-repo\tHidden\tprivate\nlperezmo/notes\tAbout Teotihuacan\tpublic\n'

function world(on: On, topics: string | null = TOPICS, packs: Packs = {}, stored: Record<string, unknown> = {}) {
  mock.env(on, { HOME })
  mock.store(on, stored)
  // An op hook answers `{ value }`, or `{ deny }` for the call to reject.
  on('fs.stat', async ($, e) => {
    const text = fileAt(e.path, topics, packs)
    return text === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false } }
  })
  on('fs.read', async ($, e) => {
    const text = fileAt(e.path, topics, packs)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.list', async ($, e) => {
    const names = filesIn(e.path, packs)
    return names === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: names.map(n => ({ name: `${n}.json`, kind: 'file' as const, size: 1, isLink: false })) }
  })
  // What the person sees, which never reaches the model.
  const shown = { statuses: [] as string[], logs: [] as string[], toasts: [] as string[] }
  on('ui.status', ($, e) => {
    if (e.text !== undefined) shown.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    shown.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    shown.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  return shown
}

/** Answers every tool call the way core would for `gh repo list`, and records what ran. */
function tools(on: On) {
  const ran: string[] = []
  on('tool.call', async ($, e) => {
    ran.push(e.tool)
    return { result: { stdout: GH_LIST, stderr: '', interrupted: false }, text: GH_LIST }
  })
  return ran
}

const placeholderIn = (text: string) => /About ([A-Z][a-z]+\d*)/.exec(text)?.[1]

describe('tool output', () => {
  test('drops the hidden repository and replaces the hidden place', async ($, on) => {
    world(on)
    tools(on)
    const r = await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    const record = r.result as { stdout: string }
    expect(record.stdout.includes('secret-repo')).toBe(false)
    expect(record.stdout.includes('Teotihuacan')).toBe(false)
    expect(record.stdout.startsWith('lperezmo/public-repo\t')).toBe(true)
    expect(placeholderIn(record.stdout)).toBeDefined()
    expect(r.context?.join('\n')).toMatch(/1 line mentioning hidden items was removed/)
  })

  test('refuses a call that uses a placeholder, and the tool never runs', async ($, on) => {
    world(on)
    const ran = tools(on)
    const first = await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    const name = placeholderIn((first.result as { stdout: string }).stdout)!
    const r = await $.tool.call({ tool: 'Bash', command: `grep -r ${name} .` })
    expect(r.deny).toMatch(/is a placeholder for a hidden item/)
    expect(ran).toEqual(['Bash'])
  })

  test('lets a placeholder through to a subagent prompt', async ($, on) => {
    world(on)
    const ran = tools(on)
    const first = await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    const name = placeholderIn((first.result as { stdout: string }).stdout)!
    const r = await $.tool.call({ tool: 'Agent', description: 'look', prompt: `Summarize ${name}.` })
    expect(r.deny).toBeUndefined()
    expect(ran).toEqual(['Bash', 'Agent'])
  })

  test('refuses a call that names the topics file', async ($, on) => {
    world(on)
    const ran = tools(on)
    const r = await $.tool.call({ tool: 'Read', file_path: 'C:\\Users\\me\\.claude\\topic-filter\\topics.json' })
    expect(r.deny).toMatch(/list of hidden topics/)
    expect(ran).toEqual([])
  })

  test('lets a file that merely mentions the topics file be written, but not the topics file itself', async ($, on) => {
    world(on)
    const ran = tools(on)
    const docs = await $.tool.call({ tool: 'Write', file_path: 'README.md', content: `Edit ${TOPICS_PATH} yourself.` })
    expect(docs.deny).toBeUndefined()
    const own = await $.tool.call({ tool: 'Write', file_path: TOPICS_PATH, content: '{}' })
    expect(own.deny).toMatch(/list of hidden topics/)
    const shell = await $.tool.call({ tool: 'Bash', command: `cat ${TOPICS_PATH}` })
    expect(shell.deny).toMatch(/list of hidden topics/)
    expect(ran).toEqual(['Write'])
  })

  test('passes everything through when there is no topics file', async ($, on) => {
    world(on, null)
    tools(on)
    const r = await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    expect((r.result as { stdout: string }).stdout).toBe(GH_LIST)
  })

  test('with no topics file, the default settings still drop repositories tagged claude-hidden', async ($, on) => {
    const shown = world(on, null)
    tools(on)
    on('process.run', async ($, e) => ({ value: { exitCode: 0, stdout: '[{"name":"secret-repo"}]', stderr: '' } }) as never)
    await $.command.run({ command: 'topic-filter', args: 'reload' } as never)
    const r = await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    expect((r.result as { stdout: string }).stdout.includes('secret-repo')).toBe(false)
    expect(shown.logs.join('\n')).toMatch(/No topics file: everything below comes from the plugin settings/)
    expect(shown.logs.join('\n')).toMatch(/"repos tagged claude-hidden": drop-line, from settings, GitHub topic claude-hidden \(1 repo\)/)
  })

  test('pauses tool calls while the topics file is broken, telling the model nothing specific', async ($, on) => {
    const shown = world(on, '{"lists": [{"terms": ["Teotihuacan", 5]}]}')
    const ran = tools(on)
    const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(r.deny).toMatch(/paused because the user's topic-filter settings have a problem/)
    expect(r.deny?.includes('lists[0]')).toBe(false)
    expect(shown.statuses.at(-1)).toMatch(/BLOCKING tool calls\. lists\[0\]\.terms\[1\] must be a string/)
    expect(shown.toasts).toHaveLength(1)
    expect(ran).toEqual([])
  })

  test('refuses to overwrite a file read with hidden content, and lets Edit through without a note', async ($, on) => {
    world(on)
    const FILE = 'C:\\work\\notes.md'
    const content = '# Notes\nsecret-repo has the photos.\nGroceries\n'
    const ran: string[] = []
    on('tool.call', async ($, e) => {
      ran.push(e.tool)
      if (e.tool === 'Read') {
        return { result: { type: 'text', file: { filePath: FILE, content, numLines: 3, startLine: 1, totalLines: 3 } }, text: content } as never
      }
      // An edit's record carries the file as it was; the model reads one line.
      return { result: { filePath: FILE, originalFile: content }, text: `The file ${FILE} has been updated successfully.` } as never
    })

    const read = await $.tool.call({ tool: 'Read', file_path: FILE })
    expect(JSON.stringify(read.result).includes('secret-repo')).toBe(false)

    const write = await $.tool.call({ tool: 'Write', file_path: 'c:/work/NOTES.md', content: '# Notes\nGroceries\n' })
    expect(write.deny).toMatch(/overwriting it whole would delete/)

    const edit = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'Groceries', new_string: 'Shopping' })
    expect(edit.deny).toBeUndefined()
    expect(edit.context).toBeUndefined()
    expect(JSON.stringify(edit.result).includes('secret-repo')).toBe(false)
    expect(ran).toEqual(['Read', 'Edit'])
  })

  test('withholds the output when filtering fails after the tool ran', async ($, on) => {
    world(on)
    on('tool.call', async () => {
      throw new Error('boom')
    })
    const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(r.deny).toMatch(/the tool ran, but its output is withheld/)
  })
})

describe('context', () => {
  test("rewrites the person's prompt and tells the model", async ($, on) => {
    world(on)
    on('prompt.submit', async ($, e) => ({ text: e.text, context: e.context }))
    const r = await $.prompt.submit({ text: 'what do we have on Teotihuacan?', wait: false, origin: { kind: 'composer' } })
    expect(r.text?.includes('Teotihuacan')).toBe(false)
    expect(r.text?.startsWith('what do we have on ')).toBe(true)
    expect(r.context?.join('\n')).toMatch(/1 hidden term was replaced/)
  })

  test('rewrites a system prompt section', async ($, on) => {
    world(on)
    on('prompt.section', async () => ({ text: '- [Teotihuacan notes](notes.md)\n- [secret-repo plan](plan.md)\n- [Groceries](g.md)\n' }))
    const r = await $.prompt.section({ name: 'memory', text: null })
    expect(r.text?.includes('Teotihuacan')).toBe(false)
    expect(r.text?.includes('secret-repo')).toBe(false)
    expect(r.text?.endsWith('- [Groceries](g.md)\n')).toBe(true)
  })

  test('rewrites CLAUDE.md and adds the explainer block', async ($, on) => {
    world(on)
    on('prompt.context', async ($, e) => ({ blocks: e.blocks }))
    const r = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'Our site: the Pyramids of Giza.' }] })
    expect(r.blocks.map(b => b.name)).toEqual(['claudeMd', 'topicFilter'])
    expect(r.blocks[0]!.text.includes('Giza')).toBe(false)
  })

  test('rewrites an injected attachment', async ($, on) => {
    world(on)
    on('prompt.attachment', async () => ({ text: 'Contents of notes.md: Teotihuacan' }))
    const r = await $.prompt.attachment({ type: 'file', text: 'x', origin: { kind: 'engine' } as never })
    expect(r.text?.includes('Teotihuacan')).toBe(false)
  })
})

describe('packs', () => {
  /** Runs one Bash call whose output is `output`, and returns what the model would read. */
  async function seen($: Engine, on: On, output: string): Promise<string> {
    on('tool.call', async () => ({ result: { stdout: output, stderr: '', interrupted: false }, text: output }))
    const r = await $.tool.call({ tool: 'Bash', command: 'cat notes.md' })
    return r.deny ?? (r.result as { stdout: string }).stdout
  }

  const usesPack = (list: Record<string, unknown>) => JSON.stringify({ lists: [{ pack: 'demo', ...list }] })

  test('hides the terms of a built-in pack', async ($, on) => {
    world(on, usesPack({}), { builtIn: { demo: pack(['Zorblax', 'Quindle']) } })
    const out = await seen($, on, 'Zorblax met Quindle.')
    expect(/Zorblax|Quindle/.test(out)).toBe(false)
  })

  test('your pack of the same name replaces the built-in one', async ($, on) => {
    world(on, usesPack({}), { mine: { demo: pack(['Quindle']) }, builtIn: { demo: pack(['Zorblax']) } })
    const out = await seen($, on, 'Zorblax met Quindle.')
    expect(out.includes('Zorblax')).toBe(true)
    expect(out.includes('Quindle')).toBe(false)
  })

  test('a list can leave terms out of its pack and add its own', async ($, on) => {
    world(on, usesPack({ exclude: ['quindle'], terms: ['Vexmoor'] }), { builtIn: { demo: pack(['Zorblax', 'Quindle']) } })
    const out = await seen($, on, 'Zorblax met Quindle in Vexmoor.')
    expect(out.includes('Quindle')).toBe(true)
    expect(/Zorblax|Vexmoor/.test(out)).toBe(false)
  })

  test('a missing pack pauses tool calls and tells the person which, with a guess', async ($, on) => {
    const shown = world(on, JSON.stringify({ lists: [{ pack: 'paleontolgy' }] }), {
      builtIn: { paleontology: pack(['Zorblax']), sports: pack(['Q1']) },
    })
    const out = await seen($, on, 'anything')
    expect(out).toMatch(/paused because/)
    expect(out.includes('paleont')).toBe(false)
    expect(shown.statuses.at(-1)).toMatch(/BLOCKING tool calls\. Pack "paleontolgy" \(lists\[0\]\) was not found\. Run/)

    await $.command.run({ command: 'topic-filter', args: '' } as never)
    const problem = shown.logs.find(line => line.startsWith('Problem: '))
    expect(problem).toMatch(/Did you mean "paleontology"\? Available: paleontology, sports\./)
  })

  test('/topic-filter shows where each list gets its terms, to the person only', async ($, on) => {
    const shown = world(on, JSON.stringify({ lists: [{ name: 'dinos', pack: 'demo', terms: ['a1', 'b2'], exclude: ['x'] }] }), {
      builtIn: { demo: pack(['Zorblax', 'Quindle']) },
    })
    tools(on)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    // The engine stamps origin and presentation; a test's call leaves them out.
    const r = await $.command.run({ command: 'topic-filter', args: '' } as never)
    expect(r.text).toBeUndefined()
    expect(shown.logs).toContain('  "dinos": replace, pack demo (built-in, 2 terms), 2 own terms, 1 excluded')
    expect(shown.logs.at(-1)).toBe('(Shown to you only; Claude does not see this.)')
  })

  test('/topic-filter packs lists every pack, what it covers, and which lists use it', async ($, on) => {
    const shown = world(on, JSON.stringify({ lists: [{ name: 'mine-list', pack: 'demo' }, { name: 'gone', pack: 'nope' }] }), {
      mine: { demo: pack(['Quindle']), mine: pack(['A1b', 'C2d'], ['h']) },
      builtIn: {
        demo: pack(['Zorblax']),
        sports: JSON.stringify({ description: 'Leagues and teams.', terms: ['Q1', 'Q2', 'Q3'], hints: [] }),
      },
    })
    const r = await $.command.run({ command: 'topic-filter', args: 'packs' } as never)
    expect(r.text).toBeUndefined()
    const text = shown.logs.join('\n')
    expect(text).toMatch(/demo \(yours\): 1 term, 0 hints, used by "mine-list"/)
    expect(text).toMatch(/mine \(yours\): 2 terms, 1 hint\n/)
    expect(text).toMatch(/demo \(built-in\): replaced by yours/)
    expect(text).toMatch(/sports \(built-in\): 3 terms, 0 hints\n {6}Leagues and teams\./)
    expect(text).toMatch(/nope: NOT FOUND, named by "gone"/)
    expect(/Quindle|Zorblax/.test(text)).toBe(false)
  })
})

describe('/topic-filter log', () => {
  test('lists what was hidden and where, to the person only', async ($, on) => {
    const shown = world(on)
    tools(on)
    on('prompt.section', async () => ({ text: 'Notes on Teotihuacan' }))
    await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    await $.prompt.section({ name: 'memory', text: null })
    await $.prompt.section({ name: 'memory', text: null })

    const r = await $.command.run({ command: 'topic-filter', args: 'log' } as never)
    expect(r.text).toBeUndefined()
    const text = shown.logs.join('\n')
    expect(text).toMatch(/ {2}Bash gh repo list\n {6}Teotihuacan -> [A-Z][a-z]+\d* \(x1\)\n {6}1 line dropped by "repos": secret-repo \(x1\)/)
    // Filtered twice, listed once.
    expect(text).toMatch(/ {2}System prompt section memory\n {6}Teotihuacan -> \S+ \(x1\)\n/)
    expect(text.includes('Hidden\tprivate')).toBe(false)
    expect(shown.logs.at(-1)).toBe('(Shown to you only; Claude does not see this.)')
  })

  test('CLAUDE.md counts once, by file, and an attachment asked again counts once', async ($, on) => {
    const shown = world(on)
    on('prompt.context', async ($, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
    on('prompt.attachment', async () => ({ text: 'Contents of notes.md: Teotihuacan' }))
    await $.prompt.context({
      blocks: [{ name: 'claudeMd', text: 'Our site: Teotihuacan.' }],
      instructionFiles: [{ path: 'C:/work/CLAUDE.md', kind: 'project', content: 'Our site: Teotihuacan.' }],
    })
    await $.prompt.attachment({ type: 'file', text: 'x', origin: { kind: 'engine' } as never })
    await $.prompt.attachment({ type: 'file', text: 'x', origin: { kind: 'engine' } as never })

    await $.command.run({ command: 'topic-filter', args: 'log' } as never)
    const text = shown.logs.join('\n')
    expect(text).toMatch(/ {2}C:\/work\/CLAUDE\.md\n {6}Teotihuacan -> \S+ \(x1\)/)
    expect(text.includes('Context block claudeMd')).toBe(false)
    expect(text).toMatch(/ {2}Attachment \(file\)\n {6}Teotihuacan -> \S+ \(x1\)/)
    expect(shown.statuses.at(-1)).toMatch(/, 3 hidden/)
  })

  test('log clear empties it', async ($, on) => {
    const shown = world(on)
    tools(on)
    await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    await $.command.run({ command: 'topic-filter', args: 'log clear' } as never)
    shown.logs.length = 0
    await $.command.run({ command: 'topic-filter', args: 'log' } as never)
    expect(shown.logs[0]).toBe('Nothing has been hidden this session yet.')
  })
})

/** The panes beneath the plugin: which are open, and every open and close asked for. */
function panes(on: On) {
  const state = { open: new Set<string>(), opened: [] as string[], closed: [] as string[] }
  on('ui.panes', () => ({ value: [...state.open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('ui.open', ($, e) => {
    state.open.add(e.id)
    state.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    state.open.delete(e.id)
    state.closed.push(e.id)
    return { value: undefined } as never
  })
  return state
}

/** A tool call made in the subagent's loop; the typings leave `agentId` off a plugin's own calls. */
const inAgent = <T extends object>(input: T): T => ({ ...input, agentId: 'agent-7' })

/** The subagents beneath the plugin, as `$.agent.list()` answers. */
function agents(on: On) {
  on('agent.list', () => ({ value: [{ id: 'agent-7', description: 'Review the diff', type: 'general-purpose', status: 'running' }] }) as never)
}

/** The Pane props a surface hands the hook; `agentId` puts that subagent's transcript in view. */
const paneProps = (agentId?: string) => ({
  title: 'topic-filter',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: agentId === undefined ? {} : { agentId },
})

/** Every button label a mounted drawing shows, in order. */
async function buttonsOf(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).map(t => t.text)
}

/** Every line of text a mounted drawing shows, in order. */
async function textOf(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text)
}

const SURFACES = ['terminal', 'desktop'] as const

describe('subagents', () => {
  test("a subagent's tool output is filtered, and a placeholder there is refused", async ($, on) => {
    world(on)
    const ran = tools(on)
    agents(on)
    const r = await $.tool.call(inAgent({ tool: 'Bash', command: 'gh repo list' }))
    const out = (r.result as { stdout: string }).stdout
    expect(out.includes('secret-repo')).toBe(false)
    expect(out.includes('Teotihuacan')).toBe(false)
    const name = placeholderIn(out)!
    const again = await $.tool.call(inAgent({ tool: 'Bash', command: `grep ${name} notes.md` }))
    expect(again.deny).toMatch(/is a placeholder for a hidden item/)
    expect(ran).toEqual(['Bash'])
  })

  test('/topic-filter log lists each subagent under its own heading', async ($, on) => {
    const shown = world(on)
    tools(on)
    agents(on)
    await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    await $.tool.call(inAgent({ tool: 'Bash', command: 'gh repo list --limit 5' }))
    await $.command.run({ command: 'topic-filter', args: 'log' } as never)
    const text = shown.logs.join('\n')
    expect(text).toMatch(/Hidden as it came in \(most recent last\):\n {2}Bash gh repo list\n/)
    expect(text).toMatch(/Hidden in subagent Review the diff \(most recent last\):\n {2}Bash gh repo list --limit 5\n/)
  })
})

describe('sidebar', () => {
  test('/topic-filter sidebar opens the pane, and closes it when open', async ($, on) => {
    const shown = world(on)
    const state = panes(on)
    await $.command.run({ command: 'topic-filter', args: 'sidebar' } as never)
    expect(state.opened).toEqual([SIDEBAR_ID])
    expect(shown.logs[0]).toMatch(/^Sidebar open\./)
    await $.command.run({ command: 'topic-filter', args: 'sidebar' } as never)
    expect(state.closed).toEqual([SIDEBAR_ID])
    expect(shown.logs.join('\n')).toMatch(/Sidebar closed\./)
  })

  test('turning the setting off closes the pane it had opened', async ($, on) => {
    world(on, TOPICS, {}, { sidebar: true })
    const state = panes(on)
    tools(on)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(state.closed).toEqual([SIDEBAR_ID])
  })

  test('a close that fails is tried again on the next call', async ($, on) => {
    world(on, TOPICS, {}, { sidebar: true })
    let attempts = 0
    on('ui.close', () => {
      attempts += 1
      if (attempts === 1) throw new Error('not ready')
      return { value: undefined } as never
    })
    tools(on)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'Bash', command: 'pwd' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(attempts).toBe(2)
  })

  test('a setting that was never on leaves panes alone', async ($, on) => {
    world(on)
    const state = panes(on)
    tools(on)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(state.opened).toEqual([])
    expect(state.closed).toEqual([])
  })

  for (const surface of SURFACES) {
    test(`draws the total, a tree open to its terms, and where hits came from (${surface})`, async ($, on) => {
      world(on)
      tools(on)
      await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
      const ui = await $.ui.mount({ plugin: 'topic-filter', surface, component: 'Pane', requestId: SIDEBAR_ID, props: paneProps() })
      const lines = await textOf(ui)
      expect(lines.slice(0, 4)).toEqual([' 2 ', ' hidden this session', '1 word replaced, 1 line dropped', 'whole session'])
      const rows = await buttonsOf(ui)
      expect(rows.slice(0, 2)).toEqual(['Lists', 'Feed'])
      expect(rows).toContain('● lists')
      expect(rows.some(row => /^▾ places +$/.test(row))).toBe(true)
      expect(rows.some(row => /^▸ Teotihuacan +$/.test(row))).toBe(true)
      expect(lines.some(line => /^ -> [A-Z][a-z]+\d*$/.test(line))).toBe(true)
      expect(lines).toContain(' line dropped')
      // Sources show only once a term is open.
      expect(lines.some(line => line.includes('Bash gh repo list'))).toBe(false)
      expect(lines).toContain('Where it came from')
      expect(lines).toContain('Commands    ')
      expect(lines.slice(-3)).toEqual(['2 terms', '2 lists', '1 source'])
    })

    test(`the depth control and row presses open and close the tree (${surface})`, async ($, on) => {
      world(on)
      tools(on)
      await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
      const ui = await $.ui.mount({ plugin: 'topic-filter', surface, component: 'Pane', requestId: SIDEBAR_ID, props: paneProps() })

      await ui.press({ key: 'depth:2' })
      await ui.redraw()
      expect(await buttonsOf(ui)).toContain('● all')
      expect((await textOf(ui)).filter(line => line === '       Bash gh repo list x1')).toHaveLength(2)

      await ui.press({ key: 'depth:0' })
      await ui.redraw()
      const closed = await buttonsOf(ui)
      expect(closed.some(row => row.includes('Teotihuacan'))).toBe(false)

      // One list opened by hand: no stop is lit, and only that list shows its terms.
      await ui.press({ key: 'row:l/places' })
      await ui.redraw()
      const one = await buttonsOf(ui)
      expect(one.filter(row => row.startsWith('●'))).toEqual([])
      expect(one.some(row => row.includes('Teotihuacan'))).toBe(true)
      expect(one.some(row => row.includes('secret-repo'))).toBe(false)
    })

    test(`the feed lists each hit, newest first (${surface})`, async ($, on) => {
      world(on)
      on('tool.call', async ($, e) => {
        const out = e.tool === 'Read' ? 'Teotihuacan again' : GH_LIST
        return { result: { stdout: out, stderr: '', interrupted: false }, text: out } as never
      })
      await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
      await $.tool.call({ tool: 'Read', file_path: 'C:/notes/trip.md' })
      const ui = await $.ui.mount({ plugin: 'topic-filter', surface, component: 'Pane', requestId: SIDEBAR_ID, props: paneProps() })
      await ui.press({ key: 'tab:feed' })
      await ui.redraw()
      const lines = await textOf(ui)
      const first = lines.indexOf('Read C:/notes/trip.md')
      const second = lines.indexOf('Bash gh repo list')
      expect(first).toBeGreaterThan(-1)
      expect(second).toBeGreaterThan(first)
      expect(lines[first - 1]).toMatch(/^\d\d:\d\d $/)
      expect(lines).toContain('      places: Teotihuacan x1')
      expect(lines).toContain('      repos: secret-repo x1; places: Teotihuacan x1')
      expect(lines).toContain('Files       ')
    })

    test(`with a subagent's transcript in view, draws only what it read (${surface})`, async ($, on) => {
      world(on)
      agents(on)
      on('tool.call', async ($, e) => {
        const out = e.tool === 'Bash' && e.command === 'cat plan.md' ? 'about secret-repo' : GH_LIST
        return { result: { stdout: out, stderr: '', interrupted: false }, text: out }
      })
      await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
      await $.tool.call(inAgent({ tool: 'Bash', command: 'cat plan.md' }))

      const ui = await $.ui.mount({ plugin: 'topic-filter', surface, component: 'Pane', requestId: SIDEBAR_ID, props: paneProps() })
      expect((await textOf(ui)).slice(-4)).toEqual(['2 terms', '2 lists', '2 sources', '1 subagent'])

      // The person opens the subagent's transcript: the same pane, drawn for that view.
      await ui.redraw(paneProps('agent-7'))
      const one = await textOf(ui)
      expect(one.slice(0, 4)).toEqual([' 1 ', ' hidden in this subagent', '1 line dropped', 'subagent Review the diff'])
      expect(one.some(line => line.includes('Teotihuacan'))).toBe(false)
      expect(one.slice(-3)).toEqual(['1 term', '1 list', '1 source'])
    })

    test(`starts collapsed from 30 terms, and counts only never names a word (${surface})`, async ($, on) => {
      world(on)
      // A pane of another id reaches the hooks beneath, which draw the view
      // with a summary of their own: the settings cannot be changed in a test.
      const hits = Array.from({ length: 30 }, (_, i) => ({ term: `Term${i}`, placeholder: `Name${i}`, list: 'pack demo', replaced: 1, dropped: 0, sources: [{ label: 'Read notes.md', n: 1 }] }))
      const summary: Summary = {
        replaced: 30,
        dropped: 0,
        terms: 30,
        lists: [{ list: 'pack demo', replaced: 30, dropped: 0, hits }],
        latest: 'Read notes.md',
        agents: [],
        kinds: [{ kind: 'files', n: 30 }],
        sources: 1,
        lastAt: 0,
        feed: [{ at: 0, label: 'Read notes.md', replaced: 30, dropped: 0, hits: hits.map(hit => ({ list: hit.list, term: hit.term, n: 1 })) }],
      }
      let countsOnly = false
      let tab: 'lists' | 'feed' = 'lists'
      on('ui.render', { component: 'Pane' }, async ($, e) => {
        const { Box, Text, Button } = await $.ui.resolve(e)
        const view = { tab, open: new Set<string>() }
        return sidebarView({ Box, Text, Button }, { summary, countsOnly, view, columns: 48, rows: 30, onPress: () => {} })
      })

      const ui = await $.ui.mount({ plugin: 'topic-filter', surface, component: 'Pane', requestId: 'other', props: paneProps() })
      const collapsed = await buttonsOf(ui)
      expect(collapsed).toContain('● none')
      expect(collapsed.some(row => row.includes('Term1'))).toBe(false)

      countsOnly = true
      await ui.redraw()
      const bare = [...(await textOf(ui)), ...(await buttonsOf(ui))]
      expect(bare.some(line => /Term|Name|notes/.test(line))).toBe(false)
      expect(bare.some(line => line.includes('pack demo'))).toBe(true)

      tab = 'feed'
      await ui.redraw()
      const feed = [...(await textOf(ui)), ...(await buttonsOf(ui))]
      expect(feed.some(line => /Term|Name|notes/.test(line))).toBe(false)
      expect(feed).toContain('30 terms')
    })
  }
})

/** `/topic-filter <args>` as the person typed it at the prompt. */
const typed = (args: string) => ({ command: 'topic-filter', args, origin: { kind: 'composer' } }) as never

describe('pause', () => {
  test('/topic-filter off lets output through and placeholders run; on filters again', async ($, on) => {
    const shown = world(on)
    const ran = tools(on)
    const first = await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    const name = placeholderIn((first.result as { stdout: string }).stdout)!

    const off = await $.command.run(typed('off'))
    expect(shown.logs[0]).toBe('topic-filter paused: nothing is hidden until /topic-filter on.')
    expect(off.context?.[0]).toMatch(/^The user paused topic-filter/)
    expect(shown.statuses.at(-1)).toMatch(/^PAUSED, nothing is hidden/)

    const open = await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    expect((open.result as { stdout: string }).stdout).toBe(GH_LIST)
    expect(open.context).toBeUndefined()
    const used = await $.tool.call({ tool: 'Bash', command: `grep ${name} notes.md` })
    expect(used.deny).toBeUndefined()

    const back = await $.command.run(typed('on'))
    expect(shown.logs.join('\n')).toMatch(/Filter on: \d+ lists, 3 terms\./)
    expect(back.context?.[0]).toMatch(/^The user turned topic-filter back on/)
    const hidden = await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    expect((hidden.result as { stdout: string }).stdout.includes('secret-repo')).toBe(false)
    const refused = await $.tool.call({ tool: 'Bash', command: `grep ${placeholderIn((hidden.result as { stdout: string }).stdout)} notes.md` })
    expect(refused.deny).toMatch(/is a placeholder for a hidden item/)
    expect(ran).toEqual(['Bash', 'Bash', 'Bash', 'Bash'])
  })

  test('pause and stop are off too, and resume and start are on', async ($, on) => {
    const shown = world(on)
    tools(on)
    for (const [arg, status] of [['pause', /^PAUSED/], ['resume', /^on, /], ['stop', /^PAUSED/], ['start', /^on, /]] as const) {
      await $.command.run(typed(arg))
      expect(shown.statuses.at(-1)).toMatch(status)
    }
  })

  test('only the person can pause: a command from anywhere else leaves the filter on', async ($, on) => {
    const shown = world(on)
    tools(on)
    for (const origin of [undefined, { kind: 'plugin', name: 'other' }, { kind: 'task-notification' }, { kind: 'peer' }, { kind: 'bridge' }]) {
      const r = await $.command.run({ command: 'topic-filter', args: 'off', ...(origin === undefined ? {} : { origin }) } as never)
      expect(r.context).toBeUndefined()
    }
    expect(shown.logs.filter(line => line.startsWith('Only you can pause'))).toHaveLength(5)
    const r = await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    expect((r.result as { stdout: string }).stdout.includes('secret-repo')).toBe(false)
  })

  test('paused, the topics file stays out of reach', async ($, on) => {
    world(on)
    const ran = tools(on)
    await $.command.run(typed('off'))
    const r = await $.tool.call({ tool: 'Bash', command: `cat ${TOPICS_PATH}` })
    expect(r.deny).toMatch(/holds the list of hidden topics/)
    expect(ran).toEqual([])
  })

  test('a file read whole while paused may be overwritten; one read in part may not', async ($, on) => {
    world(on)
    const FILE = 'C:\work\notes.md'
    const content = '# Notes\nsecret-repo has the photos.\nGroceries\n'
    const ran: string[] = []
    on('tool.call', async ($, e) => {
      ran.push(e.tool)
      if (e.tool === 'Read') {
        return { result: { type: 'text', file: { filePath: FILE, content, numLines: 3, startLine: 1, totalLines: 3 } }, text: content } as never
      }
      return { result: { filePath: FILE }, text: 'written' } as never
    })
    await $.tool.call({ tool: 'Read', file_path: FILE })
    await $.command.run(typed('off'))

    await $.tool.call({ tool: 'Read', file_path: FILE, offset: 2, limit: 1 })
    const part = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'x' })
    expect(part.deny).toMatch(/overwriting it whole would delete/)

    await $.tool.call({ tool: 'Read', file_path: FILE })
    const whole = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'x' })
    expect(whole.deny).toBeUndefined()
    expect(ran).toEqual(['Read', 'Read', 'Read', 'Write'])
  })

  test('paused while the settings are broken, the topics file stays out of reach', async ($, on) => {
    world(on, '{ not json')
    const ran = tools(on)
    await $.command.run(typed('off'))
    const own = await $.tool.call({ tool: 'Read', file_path: TOPICS_PATH })
    expect(own.deny).toMatch(/holds the list of hidden topics/)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(ran).toEqual(['Bash'])
  })

  test('a long file cut at the line cap is not read whole', async ($, on) => {
    world(on)
    const FILE = 'C:/work/long.md'
    const content = '# Notes\nsecret-repo has the photos.\n'
    const ran: string[] = []
    on('tool.call', async ($, e) => {
      ran.push(e.tool)
      if (e.tool === 'Read') {
        return { result: { type: 'text', file: { filePath: FILE, content, numLines: 2, startLine: 1, totalLines: 5000 } }, text: content } as never
      }
      return { result: { filePath: FILE }, text: 'written' } as never
    })
    await $.tool.call({ tool: 'Read', file_path: FILE })
    await $.command.run(typed('off'))
    await $.tool.call({ tool: 'Read', file_path: FILE })
    const write = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'x' })
    expect(write.deny).toMatch(/overwriting it whole would delete/)
    expect(ran).toEqual(['Read', 'Read'])
  })

  test('/clear ends the pause', async ($, on) => {
    world(on)
    tools(on)
    on('session.end', async () => ({ sessionId: 's1' }))
    await $.command.run(typed('off'))
    await $.session.end({ reason: 'clear' } as never)
    const r = await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    expect((r.result as { stdout: string }).stdout.includes('secret-repo')).toBe(false)
  })

  for (const surface of SURFACES) {
    test(`the sidebar says when filtering is paused (${surface})`, async ($, on) => {
      world(on)
      tools(on)
      await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
      await $.command.run(typed('off'))
      const ui = await $.ui.mount({ plugin: 'topic-filter', surface, component: 'Pane', requestId: SIDEBAR_ID, props: paneProps() })
      const lines = await textOf(ui)
      expect(lines[0]).toMatch(/^ PAUSED: nothing is hidden\. \/topic-filter on +$/)
      expect(lines.slice(1, 3)).toEqual([' 2 ', ' hidden this session'])
    })
  }
})
