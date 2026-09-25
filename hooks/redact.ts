// The filter: a compiled topics file that rewrites what the model is about
// to read and checks what it is about to do.
//
// Reading: every string is searched for listed terms. A `drop-line` list's
// term removes each line it appears on; where a whole string goes that way
// inside an array (one repository in a JSON listing, one path in a Glob
// result), the array's item goes with it. Everything else becomes the term's
// placeholder. JSON printed as text (`gh ... --json`) is parsed, filtered as
// structure, and printed again.
//
// Writing: a tool call that uses a placeholder is found here; the hook then
// refuses it, or for a `restore` list writes the real term back.

import type { Config } from './config.ts'
import { foldTerm, Matcher, type Match, type TermRef } from './matcher.ts'
import { assignPlaceholders, findPlaceholders } from './placeholders.ts'

/** What one filtering pass hid, for the note the model reads and the status line. */
export type Tally = {
  replaced: number
  dropped: number
  /** The placeholders written, so the note can name them. */
  names: Set<string>
  /** Each term hidden, by folded term: for the person's log only, never the model. */
  hits: Map<string, Hit>
}

/** One term's share of a pass: how often it became its placeholder, and how many lines it dropped. */
export type Hit = { term: string; placeholder: string; list: string; replaced: number; dropped: number }

export const newTally = (): Tally => ({ replaced: 0, dropped: 0, names: new Set(), hits: new Map() })

/** A filtered value: `vanished` when a dropped line took the whole of it. */
type Filtered<T> = { value: T; changed: boolean; vanished: boolean }

/** Terms shorter than this, folded, are ignored: they would match everywhere. */
const MIN_TERM_LENGTH = 2

/** Keys whose strings are enums or engine ids, never free text. */
const SKIPPED_KEYS = new Set(['type', 'kind', 'mode', 'action', 'media_type', 'mediaType', 'tool_use_id', 'agentId'])

/** Keys of `tool.call`'s input that belong to the engine, not the tool. */
const RESERVED_INPUT_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

/** Past this many characters a string is not parsed as JSON. */
const MAX_JSON_PARSE = 2_000_000

const MAX_DEPTH = 64

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Image and file bytes as text: nothing in them is a word, and a rewrite would corrupt them. */
function isEncodedBytes(s: string): boolean {
  if (s.startsWith('data:') && s.slice(0, 100).includes(';base64,')) return true
  return s.length >= 256 && /^[A-Za-z0-9+/=_-]+$/.test(s)
}

function looksLikeJson(s: string): boolean {
  const t = s.trim()
  if (t.length < 2 || t.length > MAX_JSON_PARSE) return false
  const first = t[0]
  const last = t[t.length - 1]
  return (first === '{' && last === '}') || (first === '[' && last === ']')
}

export class Filter {
  private readonly matcher = new Matcher()
  /** Folded term to its placeholder. */
  private readonly placeholderOf = new Map<string, string>()
  /** Placeholder to the term a restore writes back. */
  private readonly canonicalOf = new Map<string, string>()
  /** Placeholders whose use in a tool call is refused. */
  readonly guarded = new Set<string>()
  /** Placeholders a tool call may use; the real term is put back. */
  readonly restorable = new Set<string>()
  readonly informModel: boolean
  /** Each list's name, by index, for the person's log. */
  private readonly listNames: readonly string[]
  /** How many terms were too short to use. */
  readonly skippedTerms: number

  /**
   * @param config the parsed topics file
   * @param salt this machine's salt for placeholder names
   * @param extraTerms more terms per list index (repositories found by topic), matched as the list says
   * @param packTerms a pack's terms per list index, always matched as whole words: thousands of
   *   terms matched inside words would hide text everywhere
   */
  constructor(
    config: Config,
    salt: string,
    extraTerms: ReadonlyMap<number, readonly string[]> = new Map(),
    packTerms: ReadonlyMap<number, readonly string[]> = new Map(),
  ) {
    this.informModel = config.informModel
    this.listNames = config.lists.map(list => list.name)

    const refs: TermRef[] = []
    let skipped = 0
    config.lists.forEach((list, i) => {
      const excluded = new Set(list.exclude.map(foldTerm))
      const sources: [readonly string[], boolean][] = [
        [[...list.terms, ...(extraTerms.get(i) ?? [])], list.match === 'word'],
        [packTerms.get(i) ?? [], true],
      ]
      for (const [terms, isWordOnly] of sources) {
        for (const term of terms) {
          const folded = foldTerm(term)
          if (folded.length < MIN_TERM_LENGTH) {
            skipped += 1
            continue
          }
          if (excluded.has(folded)) continue
          refs.push({ folded, canonical: term.trim(), list: i, mode: list.mode, isWordOnly })
        }
      }
    })
    this.skippedTerms = skipped

    for (const ref of refs) this.matcher.add(ref)

    const folded = refs.map(r => r.folded)
    const names = assignPlaceholders(folded, config.placeholder, salt, {
      equal: new Set(folded),
      contain: refs.filter(r => !r.isWordOnly).map(r => r.folded),
    })

    // A term listed twice keeps its first spelling for restores, and is
    // guarded if any list holding it is not a restore list.
    const restoreOnly = new Map<string, boolean>()
    for (const ref of refs) {
      const name = names.get(ref.folded)!
      this.placeholderOf.set(ref.folded, name)
      if (!this.canonicalOf.has(name)) this.canonicalOf.set(name, ref.canonical)
      const isRestore = config.lists[ref.list]!.restore
      restoreOnly.set(name, (restoreOnly.get(name) ?? true) && isRestore)
    }
    for (const [name, isRestore] of restoreOnly) (isRestore ? this.restorable : this.guarded).add(name)
  }

  /** How many distinct terms are active. */
  get termCount(): number {
    return this.matcher.size
  }

  /** Whether `text` holds any listed term. */
  hasTerm(text: string): boolean {
    return this.matcher.test(text)
  }

  /**
   * Filters free text. `allowDrop` false makes drop-line terms placeholders
   * too: a person's own prompt keeps all its lines.
   */
  text(text: string, tally: Tally, allowDrop = true): Filtered<string> {
    let matches = this.matcher.find(text)
    if (matches.length === 0) return { value: text, changed: false, vanished: false }

    let out = text
    if (allowDrop && matches.some(m => m.ref.mode === 'drop-line')) {
      // A literal `\n` ends a line too: some output prints its newlines as text.
      const lines = text.split(/(?<=\n|\\n)/)
      const kept = lines.filter(line => {
        const dropper = this.matcher.find(line).find(m => m.ref.mode === 'drop-line')
        if (dropper !== undefined) this.hit(tally, dropper.ref).dropped += 1
        return dropper === undefined
      })
      tally.dropped += lines.length - kept.length
      if (kept.length === 0) return { value: '', changed: true, vanished: true }
      out = kept.join('')
      matches = this.matcher.find(out)
    }

    return { value: this.replace(out, matches, tally), changed: true, vanished: false }
  }

  private replace(text: string, matches: readonly Match[], tally: Tally): string {
    if (matches.length === 0) return text

    const parts: string[] = []
    let at = 0
    for (const m of matches) {
      const name = this.placeholderOf.get(m.ref.folded)!
      parts.push(text.slice(at, m.start), name, m.suffix)
      tally.replaced += 1
      tally.names.add(name)
      this.hit(tally, m.ref).replaced += 1
      at = m.end
    }
    parts.push(text.slice(at))
    return parts.join('')
  }

  /** The tally's entry for a term, made on first use. A line is dropped by the first drop-line term on it. */
  private hit(tally: Tally, ref: TermRef): Hit {
    let hit = tally.hits.get(ref.folded)
    if (hit === undefined) {
      hit = { term: ref.canonical, placeholder: this.placeholderOf.get(ref.folded)!, list: this.listNames[ref.list]!, replaced: 0, dropped: 0 }
      tally.hits.set(ref.folded, hit)
    }
    return hit
  }

  /** Filters any value: strings anywhere inside it, JSON printed as text included. */
  value(value: unknown, tally: Tally, depth = 0): Filtered<unknown> {
    if (depth > MAX_DEPTH) return { value, changed: false, vanished: false }

    if (typeof value === 'string') return this.string(value, tally, depth)

    if (Array.isArray(value)) {
      let changed = false
      const out: unknown[] = []
      for (const item of value) {
        const r = this.value(item, tally, depth + 1)
        changed ||= r.changed
        if (!r.vanished) out.push(r.value)
      }
      return changed ? { value: out, changed, vanished: false } : { value, changed, vanished: false }
    }

    if (isPlainObject(value)) {
      let changed = false
      let vanished = false
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) {
        if (SKIPPED_KEYS.has(key)) {
          out[key] = child
          continue
        }
        const r = this.value(child, tally, depth + 1)
        changed ||= r.changed
        vanished ||= r.vanished
        out[key] = r.value
      }
      return changed ? { value: out, changed, vanished } : { value, changed, vanished: false }
    }

    return { value, changed: false, vanished: false }
  }

  private string(s: string, tally: Tally, depth: number): Filtered<unknown> {
    if (isEncodedBytes(s) || !this.matcher.test(s)) return { value: s, changed: false, vanished: false }

    if (looksLikeJson(s)) {
      let parsed: unknown
      let isJson = true
      try {
        parsed = JSON.parse(s)
      } catch {
        isJson = false
      }
      if (isJson) {
        const r = this.value(parsed, tally, depth + 1)
        if (r.vanished) return { value: '', changed: true, vanished: true }
        const lead = s.slice(0, s.length - s.trimStart().length)
        const trail = s.slice(s.trimEnd().length)
        const indent = /\n([ \t]+)\S/.exec(s)?.[1]
        return { value: lead + JSON.stringify(r.value, null, indent) + trail, changed: true, vanished: false }
      }
    }

    return this.text(s, tally)
  }

  /** The guarded placeholders `input` uses, the engine's own keys aside. */
  guardedIn(input: Record<string, unknown>): string[] {
    const found = new Set<string>()
    forEachString(input, s => {
      for (const hit of findPlaceholders(s, this.guarded)) found.add(hit.name)
    })
    return [...found]
  }

  /** `input` with each restorable placeholder replaced by its real term. */
  restore(input: Record<string, unknown>): { value: Record<string, unknown>; changed: boolean } {
    if (this.restorable.size === 0) return { value: input, changed: false }

    let changed = false
    const swap = (s: string): string => {
      const hits = findPlaceholders(s, this.restorable)
      if (hits.length === 0) return s
      changed = true
      const parts: string[] = []
      let at = 0
      for (const hit of hits) {
        parts.push(s.slice(at, hit.start), this.canonicalOf.get(hit.name)!, hit.suffix)
        at = hit.end
      }
      parts.push(s.slice(at))
      return parts.join('')
    }

    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(input)) {
      out[key] = RESERVED_INPUT_KEYS.has(key) ? child : mapStrings(child, swap)
    }
    return { value: out, changed }
  }
}

/** Calls `visit` on every string in a tool call's input, the engine's own keys aside. */
export function forEachString(input: Record<string, unknown>, visit: (s: string) => void): void {
  const walk = (v: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return
    if (typeof v === 'string') visit(v)
    else if (Array.isArray(v)) for (const item of v) walk(item, depth + 1)
    else if (isPlainObject(v)) for (const child of Object.values(v)) walk(child, depth + 1)
  }
  for (const [key, child] of Object.entries(input)) {
    if (!RESERVED_INPUT_KEYS.has(key)) walk(child, 0)
  }
}

function mapStrings(v: unknown, f: (s: string) => string, depth = 0): unknown {
  if (depth > MAX_DEPTH) return v
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map(item => mapStrings(item, f, depth + 1))
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(v)) out[key] = mapStrings(child, f, depth + 1)
    return out
  }
  return v
}

/**
 * The note that tells the model what a filtered text holds, or undefined
 * when nothing was hidden. It names placeholders, never terms or lists.
 */
export function noteFor(tally: Tally, restorable: ReadonlySet<string> = new Set()): string | undefined {
  if (tally.replaced === 0 && tally.dropped === 0) return undefined

  const parts: string[] = []
  if (tally.replaced > 0) {
    const names = [...tally.names].slice(0, 12).join(', ')
    parts.push(`${tally.replaced} hidden term${tally.replaced === 1 ? ' was' : 's were'} replaced with placeholder names (${names})`)
  }
  if (tally.dropped > 0) {
    parts.push(`${tally.dropped} line${tally.dropped === 1 ? '' : 's'} mentioning hidden items ${tally.dropped === 1 ? 'was' : 'were'} removed`)
  }

  const usable = [...tally.names].filter(name => restorable.has(name))
  const rule =
    usable.length === 0
      ? 'Mentioning a placeholder in a reply is fine, but a tool call that uses one (a command, search or file edit) is refused.'
      : usable.length === tally.names.size
        ? 'These placeholders may be used in tool calls: the real name is put back before the tool runs.'
        : `Of these, ${usable.join(', ')} may be used in tool calls (the real name is put back); a tool call using any other is refused.`

  return (
    `topic-filter: ${parts.join(', and ')}. The user has hidden these items from this session. ` +
    `Treat a placeholder as an opaque name and do not guess what it stands for. ${rule}`
  )
}
