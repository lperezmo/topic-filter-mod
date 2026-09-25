import { describe, expect, test } from 'claude-code/testing'

import { parseConfig } from '../hooks/config.ts'
import { HiddenLog, label } from '../hooks/log.ts'
import { Filter, newTally, type Tally } from '../hooks/redact.ts'

const f = new Filter(
  parseConfig(
    JSON.stringify({
      lists: [
        { name: 'places', terms: ['Teotihuacan', 'Pyramids of Giza'] },
        { name: 'repos', mode: 'drop-line', terms: ['secret-repo', 'other-secret'] },
      ],
    }),
  ),
  'test-salt-0123456789',
)

/** One filtering pass over `text`, as a hook would run it. */
function pass(text: string): Tally {
  const tally = newTally()
  f.text(text, tally)
  return tally
}

describe('what a pass records', () => {
  test('each term with its placeholder, its list, and how often', () => {
    const tally = pass('Teotihuacan, then teotihuacán again, and the Pyramids of Giza.')
    const hits = [...tally.hits.values()].map(h => [h.term, h.list, h.replaced, h.dropped])
    expect(hits).toEqual([
      ['Teotihuacan', 'places', 2, 0],
      ['Pyramids of Giza', 'places', 1, 0],
    ])
    expect(tally.hits.get('teotihuacan')?.placeholder).toMatch(/^[A-Z][a-z]+\d*$/)
  })

  test('each dropped line once, under the first drop-line term on it', () => {
    const tally = pass('a/public\na/secret-repo and a/other-secret\na/other-secret\n')
    expect(tally.dropped).toBe(2)
    const dropped = [...tally.hits.values()].map(h => [h.term, h.dropped])
    expect(dropped).toEqual([
      ['secret-repo', 1],
      ['other-secret', 1],
    ])
  })

  test('the hits add up to the counts the status line uses', () => {
    const tally = pass('Teotihuacan\nsecret-repo\nGiza and the Pyramids of Giza\n')
    const hits = [...tally.hits.values()]
    expect(hits.reduce((n, h) => n + h.replaced, 0)).toBe(tally.replaced)
    expect(hits.reduce((n, h) => n + h.dropped, 0)).toBe(tally.dropped)
  })
})

describe('the log', () => {
  test('lists terms and dropped lines by source, never the dropped lines themselves', () => {
    const log = new HiddenLog()
    log.record('Read notes.md', pass('Teotihuacan and Teotihuacan'))
    log.record('Bash gh repo list', pass('a/public\na/secret-repo private stuff\n'))
    const text = log.lines().join('\n')
    expect(text).toMatch(/Read notes\.md\n\s+Teotihuacan -> [A-Z][a-z]+\d* \(x2\)/)
    expect(text).toMatch(/Bash gh repo list\n\s+1 line dropped by "repos": secret-repo \(x1\)/)
    expect(text.includes('private stuff')).toBe(false)
  })

  test('a source seen again adds up and moves to the end', () => {
    const log = new HiddenLog()
    log.record('Read a.md', pass('Teotihuacan'))
    log.record('Read b.md', pass('Teotihuacan'))
    log.record('Read a.md', pass('Teotihuacan'))
    const sources = log.lines().filter(line => /^ {2}\S/.test(line))
    expect(sources).toEqual(['  Read b.md', '  Read a.md'])
    expect(log.lines().join('\n')).toMatch(/Read a\.md\n\s+Teotihuacan -> \S+ \(x2\)/)
  })

  test('a source filtered again whole replaces its entry, and goes when nothing is hidden', () => {
    const log = new HiddenLog()
    log.record('System prompt section memory', pass('Teotihuacan'), 'standing')
    log.record('System prompt section memory', pass('Teotihuacan'), 'standing')
    expect(log.lines().join('\n')).toMatch(/\(x1\)/)
    log.record('System prompt section memory', pass('nothing here'), 'standing')
    expect(log.lines()).toEqual(['Nothing has been hidden this session yet.'])
  })

  test('what stands in every request is listed apart, outlives the cap, and survives clear', () => {
    const log = new HiddenLog()
    log.record('System prompt section memory', pass('Teotihuacan'), 'standing')
    for (let i = 0; i < 205; i++) log.record(`Read ${i}.md`, pass('Teotihuacan'))
    expect(log.lines().slice(0, 2)).toEqual([
      'Hidden in what Claude reads with every request (system prompt, CLAUDE.md):',
      '  System prompt section memory',
    ])
    log.clear()
    const after = log.lines()
    expect(after.includes('  System prompt section memory')).toBe(true)
    expect(after.includes('Hidden as it came in (most recent last):')).toBe(false)
  })

  test('sources whose cut labels match stay apart by key', () => {
    const log = new HiddenLog()
    const long = `C:/${'deep/'.repeat(30)}`
    log.record(`${long}a/CLAUDE.md`, pass('Teotihuacan'), 'standing')
    log.record(`${long}b/CLAUDE.md`, pass('nothing here'), 'standing')
    expect(log.lines().join('\n')).toMatch(/Teotihuacan ->/)
  })

  test('a pass that hid nothing adds no entry', () => {
    const log = new HiddenLog()
    log.record('Bash ls', pass('nothing here'))
    expect(log.lines()).toEqual(['Nothing has been hidden this session yet.'])
  })

  test('keeps the newest 200 sources and says how many older ones went', () => {
    const log = new HiddenLog()
    for (let i = 0; i < 205; i++) log.record(`Read ${i}.md`, pass('Teotihuacan'))
    const lines = log.lines()
    expect(lines.slice(0, 2)).toEqual(['(5 older sources not shown)', 'Hidden as it came in (most recent last):'])
    expect(lines.includes('  Read 4.md')).toBe(false)
    expect(lines.includes('  Read 5.md')).toBe(true)
    log.clear()
    expect(log.lines()).toEqual(['Nothing has been hidden this session yet.'])
  })

  test('a label is one line, cut to a readable length', () => {
    expect(label('Bash  git log\n  --oneline')).toBe('Bash git log --oneline')
    const long = label(`Bash ${'x'.repeat(300)}`)
    expect(long.length).toBe(100)
    expect(long.endsWith('...')).toBe(true)
  })
})

describe('what the sidebar reads', () => {
  test('the feed has each new pass, newest first, with its time', () => {
    let now = 1000
    const log = new HiddenLog(() => now)
    log.record('Bash gh repo list', pass('a/secret-repo\n'), 'add', undefined, undefined, 'commands')
    now = 2000
    log.record('Read trip.md', pass('Teotihuacan and Teotihuacan'), 'add', undefined, undefined, 'files')
    const { feed, lastAt } = log.summary()
    expect(feed.map(item => [item.at, item.label, item.replaced, item.dropped])).toEqual([
      [2000, 'Read trip.md', 2, 0],
      [1000, 'Bash gh repo list', 0, 1],
    ])
    expect(feed[0]!.hits).toEqual([{ list: 'places', term: 'Teotihuacan', n: 2 }])
    expect(lastAt).toBe(2000)
  })

  test('text that stands in every request joins the feed once, and keeps its time', () => {
    let now = 1000
    const log = new HiddenLog(() => now)
    log.record('CLAUDE.md', pass('Teotihuacan'), 'standing', undefined, undefined, 'context')
    now = 5000
    log.record('CLAUDE.md', pass('Teotihuacan'), 'standing', undefined, undefined, 'context')
    const { feed, lastAt } = log.summary()
    expect(feed).toHaveLength(1)
    expect(lastAt).toBe(1000)
  })

  test('each kind of source is summed, and each term names its sources, most first', () => {
    const log = new HiddenLog(() => 0)
    log.record('Read trip.md', pass('Teotihuacan Teotihuacan'), 'add', undefined, undefined, 'files')
    log.record('Your prompt', pass('Teotihuacan'), 'add', undefined, undefined, 'prompts')
    log.record('Bash ls', pass('a/secret-repo\n'), 'add', undefined, undefined, 'commands')
    const s = log.summary()
    expect(s.kinds).toEqual([
      { kind: 'files', n: 2 },
      { kind: 'prompts', n: 1 },
      { kind: 'commands', n: 1 },
    ])
    expect(s.sources).toBe(3)
    const place = s.lists.find(list => list.list === 'places')!.hits[0]!
    expect(place.sources).toEqual([
      { label: 'Read trip.md', n: 2 },
      { label: 'Your prompt', n: 1 },
    ])
  })

  test("a subagent's feed holds only its own passes, and clear empties the feed", () => {
    const log = new HiddenLog(() => 0)
    log.record('Bash ls', pass('a/secret-repo\n'))
    log.record('Read plan.md', pass('Teotihuacan'), 'add', undefined, 'agent-7', 'files')
    expect(log.summary('agent-7').feed.map(item => item.label)).toEqual(['Read plan.md'])
    expect(log.summary().feed).toHaveLength(2)
    log.clear()
    expect(log.summary().feed).toEqual([])
  })
})
