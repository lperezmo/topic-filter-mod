// What was hidden this session and where it came from, for `/topic-filter
// log`. It names the real terms, so it lives in memory only and is shown
// through `ui.log`, which never reaches the model: a file would be a second
// copy of the hidden list, somewhere the model might read it.

import type { Hit, Tally } from './redact.ts'

/** Past this many sources the oldest are forgotten. */
const MAX_SOURCES = 200

/** Past this many terms a source's entry says how many more there were. */
const MAX_TERMS_SHOWN = 20

/** Past this many characters a source's label is cut. */
const MAX_LABEL = 100

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** A source's label on one line, cut to a readable length. */
export function label(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_LABEL ? flat : `${flat.slice(0, MAX_LABEL - 3)}...`
}

export class HiddenLog {
  /** Hits by source label, least recently hidden first. */
  private readonly sources = new Map<string, Map<string, Hit>>()
  /** Sources forgotten to stay under the cap. */
  private forgotten = 0

  /**
   * Adds one pass's hits under `source`. With `replace`, the pass stands for
   * the source's whole text (a system prompt section, CLAUDE.md), which the
   * engine may compute again: its hits replace the last ones rather than add
   * up, and a pass that hid nothing removes the entry.
   */
  record(source: string, tally: Tally, replace = false): void {
    const previous = this.sources.get(source)
    if (tally.hits.size === 0) {
      if (replace && previous !== undefined) this.sources.delete(source)
      return
    }

    const hits = new Map<string, Hit>(replace || previous === undefined ? [] : previous)
    for (const [key, hit] of tally.hits) {
      const had = hits.get(key)
      // The newest placeholder and list name stand: settings may have changed since.
      hits.set(key, had === undefined ? { ...hit } : { ...hit, replaced: had.replaced + hit.replaced, dropped: had.dropped + hit.dropped })
    }
    // Newest last: a source hidden again moves to the end.
    this.sources.delete(source)
    this.sources.set(source, hits)

    while (this.sources.size > MAX_SOURCES) {
      this.sources.delete(this.sources.keys().next().value!)
      this.forgotten += 1
    }
  }

  clear(): void {
    this.sources.clear()
    this.forgotten = 0
  }

  /** The log as the person reads it. */
  lines(): string[] {
    if (this.sources.size === 0) return ['Nothing has been hidden this session yet.']

    const lines = ['Hidden this session, by where it came from (most recent last):']
    if (this.forgotten > 0) lines.push(`  (${plural(this.forgotten, 'older source')} not shown)`)
    for (const [source, hits] of this.sources) {
      lines.push(`  ${source}`)
      const all = [...hits.values()]

      const replaced = all.filter(hit => hit.replaced > 0).sort((a, b) => b.replaced - a.replaced)
      for (const hit of replaced.slice(0, MAX_TERMS_SHOWN)) {
        lines.push(`      ${hit.term} -> ${hit.placeholder} (x${hit.replaced})`)
      }
      if (replaced.length > MAX_TERMS_SHOWN) lines.push(`      and ${plural(replaced.length - MAX_TERMS_SHOWN, 'more term')}`)

      // Dropped lines are counted, never shown: only the term that dropped each.
      const byList = new Map<string, Hit[]>()
      for (const hit of all) if (hit.dropped > 0) byList.set(hit.list, [...(byList.get(hit.list) ?? []), hit])
      for (const [list, dropped] of byList) {
        dropped.sort((a, b) => b.dropped - a.dropped)
        const total = dropped.reduce((n, hit) => n + hit.dropped, 0)
        const terms = dropped
          .slice(0, MAX_TERMS_SHOWN)
          .map(hit => `${hit.term} (x${hit.dropped})`)
          .join(', ')
        const more = dropped.length > MAX_TERMS_SHOWN ? `, and ${dropped.length - MAX_TERMS_SHOWN} more` : ''
        lines.push(`      ${plural(total, 'line')} dropped by "${list}": ${terms}${more}`)
      }
    }
    return lines
  }
}
