import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

// The world beneath the plugin: a home directory, a topics file (or none),
// a store, and a status line that goes nowhere.

const HOME = '/home/tester'
const TOPICS_PATH = `${HOME}/.claude/topic-filter/topics.json`

/** The host resolves a path before hooks see it (on Windows, `/home/x` is `D:\home\x`). */
const isTopics = (path: string) => path.replace(/\\/g, '/').endsWith(TOPICS_PATH)

const TOPICS = JSON.stringify({
  lists: [
    { name: 'places', terms: ['Teotihuacan', 'Pyramids of Giza'] },
    { name: 'repos', mode: 'drop-line', terms: ['secret-repo'] },
  ],
})

const GH_LIST = 'lperezmo/public-repo\tA public one\tpublic\nlperezmo/secret-repo\tHidden\tprivate\nlperezmo/notes\tAbout Teotihuacan\tpublic\n'

function world(on: On, topics: string | null = TOPICS) {
  mock.env(on, { HOME })
  mock.store(on)
  // An op hook answers `{ value }`, or `{ deny }` for the call to reject.
  on('fs.stat', async ($, e) =>
    topics !== null && isTopics(e.path)
      ? { value: { kind: 'file' as const, size: topics.length, mtimeMs: 1, isLink: false } }
      : { deny: `ENOENT: ${e.path}` },
  )
  on('fs.read', async ($, e) =>
    topics !== null && isTopics(e.path) ? { value: topics } : { deny: `ENOENT: ${e.path}` },
  )
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
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

  test('refuses tool calls while the topics file is broken, naming no term', async ($, on) => {
    world(on, '{"lists": [{"terms": ["Teotihuacan", 5]}]}')
    const ran = tools(on)
    const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(r.deny).toMatch(/lists\[0\]\.terms\[1\] must be a string/)
    expect(r.deny?.includes('Teotihuacan')).toBe(false)
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
