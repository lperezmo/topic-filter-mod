import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

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

function world(on: On, topics: string | null = TOPICS, packs: Packs = {}) {
  mock.env(on, { HOME })
  mock.store(on)
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

  test('passes everything through when there is no topics file', async ($, on) => {
    world(on, null)
    tools(on)
    const r = await $.tool.call({ tool: 'Bash', command: 'gh repo list' })
    expect((r.result as { stdout: string }).stdout).toBe(GH_LIST)
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
