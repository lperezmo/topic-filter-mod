import { describe, expect, test } from 'claude-code/testing'

import { closestName, optionLists, parseConfig, parsePack, type Config } from '../hooks/config.ts'
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

  test('a literal \\n or \\t before a term is a word boundary', () => {
    const m = matcherOf(ref('gpmap'))
    expect(found(m, 'maps.\\ngpmap\\tpublic and \\tgpmap, not agpmap or \\xgpmap')).toEqual(['gpmap', 'gpmap'])
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

  test('names are distinct, and always numbered so none is a word people really write', () => {
    const terms = Array.from({ length: 600 }, (_, i) => `term${i}`)
    const names = assignPlaceholders(terms, 'codename', 'salt', { equal: new Set(), contain: [] })
    const values = [...names.values()]
    expect(new Set(values).size).toBe(600)
    for (const name of values) expect(name).toMatch(/^[A-Z][a-z]+\d+$/)
  })

  test('tags look like [hidden-xxxxxx]', () => {
    const names = assignPlaceholders(['giza'], 'tag', 'salt', { equal: new Set(), contain: [] })
    expect(names.get('giza')).toMatch(/^\[hidden-[0-9a-f]{6}\]$/)
  })

  test('finds a placeholder in written text, plural included, not its plain or lower-case word', () => {
    const known = new Set(['Bubblegum7', 'Kazoo12'])
    const hits = findPlaceholders('cd Bubblegum7s && ls Kazoo12 bubblegum7, a Bubblegum and a Kazoo', known)
    expect(hits.map(h => [h.name, h.suffix])).toEqual([['Bubblegum7', 's'], ['Kazoo12', '']])
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

describe('config and packs', () => {
  test('a pack name must be a plain name, never a path', () => {
    expect(() => parseConfig('{"lists": [{"pack": "../secrets"}]}')).toThrow(/lists\[0\]\.pack must be a pack name/)
  })

  test('pack errors name the pack and a position, never a term', () => {
    expect(() => parsePack('{"terms": ["Teotihuacan", 5]}', 'demo')).toThrow('pack "demo" terms[1] must be a string')
    expect(() => parsePack('nope', 'demo')).toThrow('pack "demo" is not valid JSON')
  })

  test('a mistyped pack name gets the closest real one, or nothing', () => {
    const names = ['anthropology', 'paleontology', 'sports', 'video-games']
    expect(closestName('paleontolgy', names)).toBe('paleontology')
    expect(closestName('video', names)).toBe('video-games')
    expect(closestName('sport', names)).toBe('sports')
    expect(closestName('cooking', names)).toBeUndefined()
  })

  test("a pack's terms match whole words even in a substring list", () => {
    const config = parseConfig(JSON.stringify({ lists: [{ match: 'substring', terms: ['maya'] }] }))
    const f = new Filter(config, 'salt-0123456789abcdef', new Map([[0, ['giza']]]))
    const tally = newTally()
    f.text('Mayapan and Gizamatic, then Giza', tally)
    expect(tally.replaced).toBe(2)
  })

  test('the plugin settings add lists: switched-on packs, extra words', () => {
    const lists = optionLists({
      hideChemistry: true,
      hideBiology: false,
      otherPacks: 'my-topic, chemistry',
      extraWords: ' Teotihuacan ,, Giza ',
    })
    expect(lists.map(l => l.name)).toEqual([
      'pack chemistry',
      'pack my-topic',
      'extra words',
    ])
    expect(lists.at(-1)!.terms).toEqual(['Teotihuacan', 'Giza'])
    expect(lists.find(l => l.pack === 'my-topic')!.setting).toBe('Other packs')
  })

  test('nothing chosen adds nothing, and the removed GitHub topic settings are ignored', () => {
    expect(optionLists({})).toEqual([])
    expect(optionLists({ hideTagged: true, githubTopics: 'claude-hidden' })).toEqual([])
  })

  test('a bad name in a setting names the setting and position, never the value', () => {
    expect(() => optionLists({ otherPacks: 'ok, ../secrets' })).toThrow("The Other packs setting's item 2 is not a pack name")
  })

  test('a pack without hints is fine', () => {
    expect(parsePack('{"terms": ["a"]}', 'demo')).toEqual({ name: 'demo', description: '', terms: ['a'], hints: [] })
  })

  test('exclude takes a term out of its list, by folded form', () => {
    const config = parseConfig(JSON.stringify({ lists: [{ terms: ['Teotihuacan', 'Giza'], exclude: ['TEOTIHUACÁN'] }] }))
    const f = new Filter(config, 'salt-0123456789abcdef')
    expect(f.termCount).toBe(1)
    expect(f.text('Teotihuacan and Giza', newTally()).value.startsWith('Teotihuacan and ')).toBe(true)
  })
})

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

  test('drops the lines of output that prints its newlines as \\n text', () => {
    const f = filter()
    const tally = newTally()
    const r = f.text('lperezmo/a\\tpublic\\nlperezmo/secret-repo\\tprivate\\nlperezmo/b\\tpublic\\n', tally)
    expect(r.value).toBe('lperezmo/a\\tpublic\\nlperezmo/b\\tpublic\\n')
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
