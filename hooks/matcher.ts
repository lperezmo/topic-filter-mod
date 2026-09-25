// Finds listed terms in text. Text and terms are folded the same way before
// they are compared: accents stripped, lower-cased, and every run of spaces,
// hyphens and underscores made one space, so `Teotihuacán`, `teotihuacan`
// and `TEOTIHUACAN` are one term, and `secret repo` also finds
// `secret-repo` and `secret_repo`. A match is reported in the ORIGINAL
// text's positions, so the caller replaces exactly what was written.

/** How a list hides what it finds. */
export type Mode = 'replace' | 'drop-line'

/** One listed term, as the matcher reports it. */
export type TermRef = {
  /** The term folded, the key its placeholder is kept under. */
  folded: string
  /** The term as the topics file spells it; what a restore writes back. */
  canonical: string
  /** Index of the list the term came from. */
  list: number
  mode: Mode
  /** Whether the term must stand as whole words (true) or may sit inside one. */
  isWordOnly: boolean
}

/** A term found in a text: `[start, end)` in the original's UTF-16 indices. */
export type Match = {
  start: number
  end: number
  ref: TermRef
  /** A plural ending (`s`, `es`) the match took after the term, as written. */
  suffix: string
}

/** Text folded for matching, with each folded unit's span in the original. */
type Folded = {
  text: string
  starts: number[]
  ends: number[]
}

const SEPARATOR = /[\s\-_‐-―]/u
const MARKS = /\p{M}+/gu
const WORD = /[\p{L}\p{N}]/u

/** Folds one code point the way terms are folded. */
function foldChar(ch: string): string {
  if (ch === '’' || ch === '‘') return "'"
  return ch.normalize('NFD').replace(MARKS, '').toLowerCase()
}

/** Folds a whole text, keeping where each folded unit came from. */
function fold(text: string): Folded {
  const out: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let pos = 0
  let lastWasSeparator = false

  for (const ch of text) {
    const start = pos
    pos += ch.length

    if (SEPARATOR.test(ch)) {
      if (lastWasSeparator) {
        ends[ends.length - 1] = pos
      } else {
        out.push(' ')
        starts.push(start)
        ends.push(pos)
      }
      lastWasSeparator = true
      continue
    }

    lastWasSeparator = false
    for (const unit of foldChar(ch)) {
      out.push(unit)
      starts.push(start)
      ends.push(pos)
    }
  }

  return { text: out.join(''), starts, ends }
}

/** A term folded on its own, trimmed: the key terms are compared by. */
export function foldTerm(term: string): string {
  return fold(term).text.trim()
}

type Node = {
  next: Map<string, Node>
  ref?: TermRef
}

const isWordAt = (text: string, i: number) => i >= 0 && i < text.length && WORD.test(text[i]!)

/**
 * A literal escape such as `\n` or `\t` (backslash, letter) ends the word
 * before it: `gh --template '...\n...'` and logs print them as text, and
 * `\ngpmap` must still find `gpmap`.
 */
const startsWord = (text: string, i: number) =>
  !isWordAt(text, i - 1) || (text[i - 2] === '\\' && 'ntr'.includes(text[i - 1]!))

/** Matches a set of terms in text, leftmost first and longest at each start. */
export class Matcher {
  private readonly root: Node = { next: new Map() }
  private count = 0

  /** How many distinct folded terms the matcher holds. */
  get size(): number {
    return this.count
  }

  /**
   * Adds a term. A term folded the same as one already held keeps the first
   * list's settings, unless the new one drops lines where the held one only
   * replaces: the stronger hiding wins.
   */
  add(ref: TermRef): void {
    let node = this.root
    for (const unit of ref.folded) {
      let child = node.next.get(unit)
      if (child === undefined) {
        child = { next: new Map() }
        node.next.set(unit, child)
      }
      node = child
    }

    if (node.ref === undefined) {
      node.ref = ref
      this.count += 1
    } else if (node.ref.mode === 'replace' && ref.mode === 'drop-line') {
      node.ref = ref
    }
  }

  /** Every term in `text`, left to right, none overlapping. */
  find(text: string): Match[] {
    if (this.count === 0 || text.length === 0) return []

    const folded = fold(text)
    const t = folded.text
    const matches: Match[] = []
    let i = 0

    while (i < t.length) {
      const found = this.longestAt(t, i)
      if (found === undefined) {
        i += 1
        continue
      }

      const [endExclusive, ref, suffixLength] = found
      const last = endExclusive + suffixLength - 1
      const termEnd = folded.ends[endExclusive - 1]!
      const end = folded.ends[last]!
      matches.push({
        start: folded.starts[i]!,
        end,
        ref,
        suffix: text.slice(termEnd, end),
      })
      i = endExclusive + suffixLength
    }

    return matches
  }

  /** True when `text` holds any term; cheaper to say than `find` is to list. */
  test(text: string): boolean {
    return this.find(text).length > 0
  }

  /**
   * The longest term starting at folded index `i` that stands where it is:
   * `[end, ref, suffixLength]`, or undefined.
   */
  private longestAt(t: string, i: number): [number, TermRef, number] | undefined {
    if (t[i] === ' ') return undefined

    const boundaryBefore = startsWord(t, i)
    let node: Node | undefined = this.root
    let best: [number, TermRef, number] | undefined
    let j = i

    while (j < t.length) {
      node = node.next.get(t[j]!)
      if (node === undefined) break
      j += 1

      const ref = node.ref
      if (ref === undefined) continue

      if (!ref.isWordOnly) {
        best = [j, ref, 0]
        continue
      }
      if (!boundaryBefore) continue

      if (!isWordAt(t, j)) {
        best = [j, ref, 0]
      } else if (t[j] === 's' && !isWordAt(t, j + 1)) {
        best = [j, ref, 1]
      } else if (t[j] === 'e' && t[j + 1] === 's' && !isWordAt(t, j + 2)) {
        best = [j, ref, 2]
      }
    }

    return best
  }
}
