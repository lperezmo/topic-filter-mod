import { describe, expect, test } from 'claude-code/testing'

import { parseConfig, type Config } from '../hooks/config.ts'
import { foldTerm, Matcher, type TermRef } from '../hooks/matcher.ts'
import { assignPlaceholders, findPlaceholders } from '../hooks/placeholders.ts'
import { Filter, newTally, noteFor } from '../hooks/redact.ts'

const ref = (term: string, over: Partial<TermRef> = {}): TermRef => ({
  folded: foldTerm(term),
  canonical: term,
  list: 0,
  mode: 'replace',
  isWordOnly: true,
  ...over,
})

const matcherOf = (...refs: TermRef[]) => {
  const m = new Matcher()
  for (const r of refs) m.add(r)
  return m
}

const found = (m: Matcher, text: string) => m.find(text).map(x => text.slice(x.start, x.end))

describe('matcher', () => {
  test('ignores accents and case', () => {
    const m = matcherOf(ref('Teotihuacan'))
    expect(found(m, 'Teotihuacán, TEOTIHUACAN and teotihuacan')).toEqual(['Teotihuacán', 'TEOTIHUACAN', 'teotihuacan'])
  })

  test('matches whole words only, with plural and possessive endings', () => {
    const m = matcherOf(ref('Maya'))
    expect(found(m, 'the Maya, two Mayas, the Maya’s calendar, Mayapan, Himalaya')).toEqual(['Maya', 'Mayas', 'Maya'])
  })

  test('a substring list matches inside words', () => {
    const m = matcherOf(ref('maya', { isWordOnly: false }))
    expect(found(m, 'Mayapan')).toEqual(['Maya'])
  })

  test('spaces, hyphens and underscores are one separator', () => {
    const m = matcherOf(ref('secret repo'))
    expect(found(m, 'secret-repo secret_repo secret  repo secretrepo')).toEqual(['secret-repo', 'secret_repo', 'secret  repo'])
  })

  test('takes the longest term at a position', () => {
    const m = matcherOf(ref('Giza'), ref('Pyramids of Giza'))
    expect(found(m, 'the Pyramids of Giza and Giza itself')).toEqual(['Pyramids of Giza', 'Giza'])
  })

  test('finds a term inside a path', () => {
    const m = matcherOf(ref('secret-repo'))
    expect(found(m, 'D:\\Python\\secret-repo\\main.py and /home/me/secret-repo/')).toEqual(['secret-repo', 'secret-repo'])
  })
})

describe('placeholders', () => {
  test('a term keeps its name for the same salt, whatever else is listed', () => {
    const avoid = { equal: new Set<string>(), contain: [] }
    const a = assignPlaceholders(['teotihuacan'], 'codename', 'salt-one-0123456', avoid)
    const b = assignPlaceholders(['teotihuacan', 'chichen itza'], 'codename', 'salt-one-0123456', avoid)
    expect(a.get('teotihuacan')).toBe(b.get('teotihuacan'))
  })

  test('names are distinct and never a listed term', () => {
    const terms = Array.from({ length: 600 }, (_, i) => `term${i}`)
    const names = assignPlaceholders(terms, 'codename', 'salt', { equal: new Set(['bubblegum']), contain: [] })
    const values = [...names.values()]
    expect(new Set(values).size).toBe(600)
    expect(values.includes('Bubblegum')).toBe(false)
  })

  test('tags look like [hidden-xxxxxx]', () => {
    const names = assignPlaceholders(['giza'], 'tag', 'salt', { equal: new Set(), contain: [] })
    expect(names.get('giza')).toMatch(/^\[hidden-[0-9a-f]{6}\]$/)
  })

  test('finds a placeholder in written text, plural included, not its lower-case word', () => {
    const known = new Set(['Bubblegum', 'Kazoo2'])
    const hits = findPlaceholders('cd Bubblegums && ls Kazoo2 bubblegum', known)
    expect(hits.map(h => [h.name, h.suffix])).toEqual([['Bubblegum', 's'], ['Kazoo2', '']])
  })
})

const CONFIG: Config = parseConfig(
  JSON.stringify({
    lists: [
      { name: 'places', terms: ['Teotihuacan', 'Chichen Itza', 'Pyramids of Giza'] },
      { name: 'repos', mode: 'drop-line', terms: ['secret-repo'] },
      { name: 'people', restore: true, terms: ['Ada Lovelace'] },
      { name: 'short', terms: ['x'] },
    ],
  }),
)

const filter = () => new Filter(CONFIG, 'test-salt-0123456789')

describe('filter', () => {
  test('replaces a term and keeps the rest of the text', () => {
    const f = filter()
    const tally = newTally()
    const r = f.text('We visited Teotihuacán yesterday.', tally)
    expect(r.value).toMatch(/^We visited [A-Z][a-z]+\d* yesterday\.$/)
    expect(r.value.includes('Teotihuac')).toBe(false)
    expect(tally.replaced).toBe(1)
  })

  test('drops the lines of a drop-line term', () => {
    const f = filter()
    const tally = newTally()
    const r = f.text('lperezmo/public-repo\tpublic\nlperezmo/secret-repo\tprivate\nlperezmo/other\tpublic\n', tally)
    expect(r.value).toBe('lperezmo/public-repo\tpublic\nlperezmo/other\tpublic\n')
    expect(tally.dropped).toBe(1)
  })

  test("a person's prompt keeps its lines: drop-line terms become placeholders there", () => {
    const f = filter()
    const r = f.text('look at secret-repo please', newTally(), false)
    expect(r.value.includes('secret-repo')).toBe(false)
    expect(r.value.startsWith('look at ')).toBe(true)
  })

  test('drops the items of a JSON listing printed as text, keeping its indent', () => {
    const f = filter()
    const listing = JSON.stringify([{ name: 'secret-repo' }, { name: 'ok-repo' }], null, 2) + '\n'
    const r = f.value({ stdout: listing, stderr: '' }, newTally())
    expect(r.value).toEqual({ stdout: JSON.stringify([{ name: 'ok-repo' }], null, 2) + '\n', stderr: '' })
  })

  test('drops a path from a list of paths', () => {
    const f = filter()
    const r = f.value({ filenames: ['a/secret-repo/x.ts', 'b.ts'], numFiles: 2 }, newTally())
    expect(r.value).toEqual({ filenames: ['b.ts'], numFiles: 2 })
  })

  test('leaves encoded bytes and enum keys alone', () => {
    const f = filter()
    const bytes = 'A'.repeat(300) + 'Teotihuacan' + 'B'.repeat(10)
    const r = f.value({ type: 'Teotihuacan', data: bytes }, newTally())
    expect(r.changed).toBe(false)
  })

  test('returns the same object when nothing matched', () => {
    const f = filter()
    const value = { stdout: 'nothing here', stderr: '' }
    expect(f.value(value, newTally()).value).toBe(value)
  })

  test('ignores terms too short to use', () => {
    expect(filter().skippedTerms).toBe(1)
  })

  test('guards placeholders of ordinary lists and restores those of restore lists', () => {
    const f = filter()
    const tally = newTally()
    const hidden = f.text('Teotihuacan and Ada Lovelace', tally).value
    const [place, person] = [...tally.names]
    expect(f.guardedIn({ tool: 'Bash', command: `grep ${place} notes.md` })).toEqual([place!])
    expect(f.guardedIn({ tool: 'Bash', command: `echo ${person}` })).toEqual([])
    const restored = f.restore({ tool: 'Write', file_path: 'a.md', content: `Dear ${person},` })
    expect(restored.value).toEqual({ tool: 'Write', file_path: 'a.md', content: 'Dear Ada Lovelace,' })
    expect(hidden.includes('Ada')).toBe(false)
  })

  test('the note names placeholders, never terms', () => {
    const f = filter()
    const tally = newTally()
    f.text('Teotihuacan\nsecret-repo\n', tally)
    const note = noteFor(tally)!
    expect(note).toMatch(/1 hidden term was replaced/)
    expect(note).toMatch(/1 line mentioning hidden items was removed/)
    expect(/teotihuacan|secret-repo|places|repos/i.test(note)).toBe(false)
    expect(note).toMatch(/Mentioning a placeholder in a reply is fine/)
  })

  test('the note says which placeholders a tool call may use', () => {
    const f = filter()
    const tally = newTally()
    f.text('Teotihuacan and Ada Lovelace', tally)
    const [place, person] = [...tally.names]
    const note = noteFor(tally, f.restorable)!
    expect(note).toMatch(new RegExp(`Of these, ${person} may be used in tool calls`))
    expect(note.includes(`${place} may be used`)).toBe(false)
  })
})
