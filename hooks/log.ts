// What was hidden this session and where it came from, for `/topic-filter
// log`. It names the real terms, so it lives in memory only and is shown
// through `ui.log`, which never reaches the model: a file of its own would be
// a second copy of the hidden list, somewhere the model might read it. The
// engine's debug log does get every `ui.log` line, as the README says.

import type { Hit, Tally } from './redact.ts'

/** Past this many passing sources the oldest are forgotten. */
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

/**
 * How a pass joins the log:
 * - `add`: something read once (a tool's output, a prompt); passes add up.
 * - `replace`: the pass covers the source's whole text and may run again for
 *   the same text (an attachment asked again after a reload); it replaces the
 *   last one, and a pass that hid nothing removes the entry.
 * - `standing`: like `replace`, for text in every request of the session (a
 *   system prompt section, CLAUDE.md). Kept apart, never forgotten to the
 *   cap, and kept by `clear`, since the engine may not filter it again.
 */
export type LogMode = 'add' | 'replace' | 'standing'

type Entry = { label: string; hits: Map<string, Hit> }

export class HiddenLog {
  /** Passing sources by key, least recently hidden first. */
  private readonly passing = new Map<string, Entry>()
  /** Standing sources by key. */
  private readonly standing = new Map<string, Entry>()
  /** Passing sources forgotten to stay under the cap. */
  private forgotten = 0

  /**
   * Adds one pass's hits under `source`, shown cut to one line; `key` tells
   * sources apart when their labels could match (a long path cut short).
   */
  record(source: string, tally: Tally, mode: LogMode = 'add', key: string = source): void {
    const entries = mode === 'standing' ? this.standing : this.passing
    const previous = entries.get(key)
    if (tally.hits.size === 0) {
      if (mode !== 'add' && previous !== undefined) entries.delete(key)
      return
    }

    const hits = new Map<string, Hit>(mode !== 'add' || previous === undefined ? [] : previous.hits)
    for (const [term, hit] of tally.hits) {
      const had = hits.get(term)
      // The newest placeholder and list name stand: settings may have changed since.
      hits.set(term, had === undefined ? { ...hit } : { ...hit, replaced: had.replaced + hit.replaced, dropped: had.dropped + hit.dropped })
    }
    // Newest last: a source hidden again moves to the end.
    entries.delete(key)
    entries.set(key, { label: label(source), hits })

    while (this.passing.size > MAX_SOURCES) {
      this.passing.delete(this.passing.keys().next().value!)
      this.forgotten += 1
    }
  }

  /** Empties what passed; what stands in every request stays, as it is still hidden there. */
  clear(): void {
    this.passing.clear()
    this.forgotten = 0
  }

  /** The log as the person reads it. */
  lines(): string[] {
    if (this.passing.size === 0 && this.standing.size === 0) return ['Nothing has been hidden this session yet.']

    const lines: string[] = []
    if (this.standing.size > 0) {
      lines.push('Hidden in what Claude reads with every request (system prompt, CLAUDE.md):')
      for (const entry of this.standing.values()) lines.push(...entryLines(entry))
    }
    if (this.passing.size > 0) {
      lines.push('Hidden as it came in (most recent last):')
      if (this.forgotten > 0) lines.push(`  (${plural(this.forgotten, 'older source')} not shown)`)
      for (const entry of this.passing.values()) lines.push(...entryLines(entry))
    }
    return lines
  }
}

/** One source: its label, each replaced term, then the lines each list dropped (counted, never shown). */
function entryLines({ label, hits }: Entry): string[] {
  const lines = [`  ${label}`]
  const all = [...hits.values()]

  const replaced = all.filter(hit => hit.replaced > 0).sort((a, b) => b.replaced - a.replaced)
  for (const hit of replaced.slice(0, MAX_TERMS_SHOWN)) {
    lines.push(`      ${hit.term} -> ${hit.placeholder} (x${hit.replaced})`)
  }
  if (replaced.length > MAX_TERMS_SHOWN) lines.push(`      and ${plural(replaced.length - MAX_TERMS_SHOWN, 'more term')}`)

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
  return lines
}
