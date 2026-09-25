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

/** One source's hits; `agent` is the subagent whose loop read it, absent for the main conversation. */
type Entry = { label: string; agent?: string; hits: Map<string, Hit> }

/** One list's share of a summary: its hits merged across sources, most hidden first. */
export type ListSummary = { list: string; replaced: number; dropped: number; hits: Hit[] }

/** What the sidebar draws: totals, each list's share, and where the last hit came from. */
export type Summary = {
  replaced: number
  dropped: number
  /** Distinct terms hidden. */
  terms: number
  lists: ListSummary[]
  /** The label of the most recent source with a hit, if any. */
  latest?: string
  /** The subagents with hits, in the order they first hid something. */
  agents: string[]
}

export class HiddenLog {
  /** Passing sources by key, least recently hidden first. */
  private readonly passing = new Map<string, Entry>()
  /** Standing sources by key. */
  private readonly standing = new Map<string, Entry>()
  /** Passing sources forgotten to stay under the cap. */
  private forgotten = 0

  /**
   * Adds one pass's hits under `source`, shown cut to one line; `key` tells
   * sources apart when their labels could match (a long path cut short), and
   * `agent` names the subagent whose loop read it.
   */
  record(source: string, tally: Tally, mode: LogMode = 'add', key: string = source, agent?: string): void {
    const entries = mode === 'standing' ? this.standing : this.passing
    key = agent === undefined ? key : `${agent}\u0000${key}`
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
    entries.set(key, agent === undefined ? { label: label(source), hits } : { label: label(source), agent, hits })

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

  /** The log as the person reads it; `agentName` labels a subagent by its id. */
  lines(agentName: (agent: string) => string = agent => agent): string[] {
    if (this.passing.size === 0 && this.standing.size === 0) return ['Nothing has been hidden this session yet.']

    const lines: string[] = []
    if (this.standing.size > 0) {
      lines.push('Hidden in what Claude reads with every request (system prompt, CLAUDE.md):')
      for (const entry of this.standing.values()) lines.push(...entryLines(entry))
    }
    if (this.forgotten > 0) lines.push(`(${plural(this.forgotten, 'older source')} not shown)`)

    // The main conversation first, then each subagent in the order it first hid something.
    const byAgent = new Map<string | undefined, Entry[]>()
    for (const entry of this.passing.values()) byAgent.set(entry.agent, [...(byAgent.get(entry.agent) ?? []), entry])
    const main = byAgent.get(undefined)
    if (main !== undefined) {
      lines.push('Hidden as it came in (most recent last):')
      for (const entry of main) lines.push(...entryLines(entry))
    }
    for (const [agent, entries] of byAgent) {
      if (agent === undefined) continue
      lines.push(`Hidden in subagent ${agentName(agent)} (most recent last):`)
      for (const entry of entries) lines.push(...entryLines(entry))
    }
    return lines
  }

  /**
   * Totals and each list's share, for the sidebar: the whole session, or one
   * subagent's own reads when `agent` is given.
   */
  summary(agent?: string): Summary {
    const inScope = (entry: Entry) => agent === undefined || entry.agent === agent
    const entries = [...(agent === undefined ? this.standing.values() : []), ...this.passing.values()].filter(inScope)

    const byTerm = new Map<string, Hit>()
    for (const entry of entries) {
      for (const [term, hit] of entry.hits) {
        const had = byTerm.get(term)
        byTerm.set(term, had === undefined ? { ...hit } : { ...hit, replaced: had.replaced + hit.replaced, dropped: had.dropped + hit.dropped })
      }
    }

    const byList = new Map<string, ListSummary>()
    for (const hit of byTerm.values()) {
      const list = byList.get(hit.list) ?? { list: hit.list, replaced: 0, dropped: 0, hits: [] }
      list.replaced += hit.replaced
      list.dropped += hit.dropped
      list.hits.push(hit)
      byList.set(hit.list, list)
    }
    const weight = (x: { replaced: number; dropped: number }) => x.replaced + x.dropped
    const lists = [...byList.values()].sort((a, b) => weight(b) - weight(a))
    for (const list of lists) list.hits.sort((a, b) => weight(b) - weight(a))

    const passing = [...this.passing.values()].filter(inScope)
    const agents = [...new Set([...this.passing.values()].flatMap(entry => (entry.agent === undefined ? [] : [entry.agent])))]
    return {
      replaced: lists.reduce((n, list) => n + list.replaced, 0),
      dropped: lists.reduce((n, list) => n + list.dropped, 0),
      terms: byTerm.size,
      lists,
      ...(passing.length > 0 ? { latest: passing.at(-1)!.label } : {}),
      agents,
    }
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
