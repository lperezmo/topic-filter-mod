// Gives each hidden term the name the model reads in its place, and finds
// those names again in what the model writes. A term's name depends only on
// the term and this machine's salt, never on the session or on which text
// it turned up in, so memory files, the prompt cache and a long transcript
// stay consistent. The salt keeps the mapping from being recomputed by
// anyone who has the word list but not this machine's store.

import { CODENAMES } from './codenames.ts'

export type PlaceholderStyle = 'codename' | 'tag'

/** 32-bit FNV-1a: small, fast, and good enough to spread terms over names. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

const CODENAME_SHAPE = /\b([A-Z][a-z]+)(\d*)(e?s)?\b/g
const TAG_SHAPE = /\[hidden-[0-9a-f]{6}\](e?s)?/g

/** One placeholder found in a text written by the model. */
export type PlaceholderHit = {
  start: number
  end: number
  name: string
  /** A plural ending written after the name. */
  suffix: string
}

/**
 * The names for a set of folded terms. `avoid` lists folded strings no
 * codename may equal or contain (the terms themselves, so a codename is
 * never mistaken for a hidden word).
 */
export function assignPlaceholders(
  foldedTerms: readonly string[],
  style: PlaceholderStyle,
  salt: string,
  avoid: { equal: ReadonlySet<string>; contain: readonly string[] },
): Map<string, string> {
  const names = new Map<string, string>()
  const taken = new Set<string>()
  const unique = [...new Set(foldedTerms)].sort()

  for (const term of unique) {
    const hash = fnv1a(`${salt}\u0000${term}`)
    names.set(term, style === 'tag' ? tagFor(hash, taken) : codenameFor(hash, taken, avoid))
  }

  return names
}

function codenameFor(
  hash: number,
  taken: Set<string>,
  avoid: { equal: ReadonlySet<string>; contain: readonly string[] },
): string {
  const n = CODENAMES.length
  const first = hash % n

  for (let c = 0; ; c += 1) {
    const round = Math.floor((first + c) / n)
    const word = CODENAMES[(first + c) % n]!
    const name = round === 0 ? word : `${word}${round + 1}`
    const lower = name.toLowerCase()
    if (taken.has(name) || avoid.equal.has(lower) || avoid.contain.some(t => lower.includes(t))) continue
    taken.add(name)
    return name
  }
}

function tagFor(hash: number, taken: Set<string>): string {
  for (let h = hash; ; h = (h + 1) >>> 0) {
    const name = `[hidden-${h.toString(16).padStart(8, '0').slice(0, 6)}]`
    if (taken.has(name)) continue
    taken.add(name)
    return name
  }
}

/** Every placeholder of `known` in `text`, left to right. */
export function findPlaceholders(text: string, known: ReadonlySet<string>): PlaceholderHit[] {
  const hits: PlaceholderHit[] = []

  for (const m of text.matchAll(CODENAME_SHAPE)) {
    // The letters are greedy, so `Bubblegums` arrives whole: try it, then
    // without a plural ending.
    const word = `${m[1]}${m[2]}`
    const suffix = m[3] ?? ''
    const end = m.index + m[0].length
    for (const cut of suffix === '' ? [0, 1, 2] : [0]) {
      const name = word.slice(0, word.length - cut)
      const ending = word.slice(word.length - cut) + suffix
      if ((cut === 0 || /^e?s$/.test(ending)) && known.has(name)) {
        hits.push({ start: m.index, end, name, suffix: ending })
        break
      }
    }
  }
  for (const m of text.matchAll(TAG_SHAPE)) {
    const name = m[0].slice(0, m[0].length - (m[1]?.length ?? 0))
    if (known.has(name)) {
      hits.push({ start: m.index, end: m.index + m[0].length, name, suffix: m[1] ?? '' })
    }
  }

  return hits.sort((a, b) => a.start - b.start)
}
