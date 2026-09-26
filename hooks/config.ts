// Reads topics.json. Errors name a position (`lists[1].terms[3]`), never a
// term, because an error can reach the transcript and the terms are exactly
// what must not.

import type { Mode } from './matcher.ts'
import type { PlaceholderStyle } from './placeholders.ts'

export type ListConfig = {
  name: string
  mode: Mode
  /** `word`: a term matches only as whole words. `substring`: anywhere. */
  match: 'word' | 'substring'
  /** Put the real term back when the model uses this list's placeholder in a tool call. */
  restore: boolean
  terms: string[]
  /** A topic pack whose terms join `terms`: the user's own file first, else the built-in one. */
  pack?: string
  /** Terms left out of this list, whatever brought them in (the pack or `terms`). */
  exclude: string[]
  /** The plugin option this list came from; absent for the topics file's own lists. */
  setting?: string
}

export type Config = {
  placeholder: PlaceholderStyle
  /** Tell the model that placeholders exist and how to treat them. */
  informModel: boolean
  lists: ListConfig[]
}

export class ConfigError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, where: string): T {
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw new ConfigError(`${where} must be one of ${allowed.join(', ')}`)
}

function flag(value: unknown, fallback: boolean, where: string): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  throw new ConfigError(`${where} must be true or false`)
}

/** Parses and checks the topics file's text. */
export function parseConfig(text: string): Config {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ConfigError('topics.json is not valid JSON')
  }
  if (!isRecord(raw)) throw new ConfigError('topics.json must hold an object')

  const lists = raw.lists
  if (!Array.isArray(lists)) throw new ConfigError('lists must be an array')

  return {
    placeholder: oneOf(raw.placeholder, ['codename', 'tag'] as const, 'codename', 'placeholder'),
    informModel: flag(raw.informModel, true, 'informModel'),
    lists: lists.map((list, i) => parseList(list, i)),
  }
}

function parseList(list: unknown, i: number): ListConfig {
  const at = `lists[${i}]`
  if (!isRecord(list)) throw new ConfigError(`${at} must be an object`)

  const pack = list.pack
  if (pack !== undefined && (typeof pack !== 'string' || !SLUG.test(pack))) {
    throw new ConfigError(`${at}.pack must be a pack name (lowercase letters, digits, hyphens)`)
  }

  return {
    name: typeof list.name === 'string' ? list.name : `list ${i + 1}`,
    mode: oneOf(list.mode, ['replace', 'drop-line'] as const, 'replace', `${at}.mode`),
    match: oneOf(list.match, ['word', 'substring'] as const, 'word', `${at}.match`),
    restore: flag(list.restore, false, `${at}.restore`),
    terms: strings(list.terms, `${at}.terms`),
    pack,
    exclude: strings(list.exclude, `${at}.exclude`),
  }
}

/** A pack name: also safe as a file name, never a path. */
export const SLUG = /^[a-z0-9][a-z0-9-]*$/

/** The built-in packs' switches in the plugin's settings, by option key. */
export const PACK_OPTIONS: Readonly<Record<string, string>> = {
  hideAnthropology: 'anthropology',
  hideBiology: 'biology',
  hideChemistry: 'chemistry',
  hideCybersecurity: 'cybersecurity',
  hideGenetics: 'genetics',
}

/** A comma-separated option (or a list option) as its items. */
function items(value: unknown): string[] {
  const parts = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : []
  return parts.filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(s => s !== '')
}

function slugs(value: unknown, setting: string, what: string): string[] {
  const names = items(value).map(s => s.toLowerCase())
  const bad = names.findIndex(name => !SLUG.test(name))
  if (bad >= 0) throw new ConfigError(`The ${setting} setting's item ${bad + 1} is not a ${what} (lowercase letters, digits, hyphens).`)
  return [...new Set(names)]
}

/**
 * The lists the plugin's own settings (`/plugin configure`, `/config`) add to
 * the topics file's: switched-on packs and extra words. The topics file is then only needed for more than
 * this.
 */
export function optionLists(options: Readonly<Record<string, unknown>>): ListConfig[] {
  const list = (over: Partial<ListConfig> & { name: string; setting: string }): ListConfig => ({
    mode: 'replace',
    match: 'word',
    restore: false,
    terms: [],
    exclude: [],
    ...over,
  })
  const lists: ListConfig[] = []

  const packs = new Map<string, string>()
  for (const [key, pack] of Object.entries(PACK_OPTIONS)) {
    if (options[key] === true) packs.set(pack, `Hide ${pack}`)
  }
  for (const pack of slugs(options.otherPacks, 'Other packs', 'pack name')) {
    if (!packs.has(pack)) packs.set(pack, 'Other packs')
  }
  for (const [pack, setting] of packs) lists.push(list({ name: `pack ${pack}`, setting, pack }))

  const words = items(options.extraWords)
  if (words.length > 0) lists.push(list({ name: 'extra words', setting: 'Extra words to hide', terms: words }))

  return lists
}

function strings(value: unknown, where: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ConfigError(`${where} must be an array`)
  value.forEach((item, j) => {
    if (typeof item !== 'string') throw new ConfigError(`${where}[${j}] must be a string`)
  })
  return value as string[]
}

/** The candidate a mistyped name most likely meant, or undefined when none is close. */
export function closestName(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of candidates) {
    if (candidate.startsWith(name) || name.startsWith(candidate)) return candidate
    const d = editDistance(name, candidate)
    if (d < bestDistance) {
      best = candidate
      bestDistance = d
    }
  }
  return bestDistance <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i]
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    row = next
  }
  return row[b.length]!
}

/** A topic pack as its file holds it; only `terms` hides anything today. */
export type Pack = {
  name: string
  description: string
  terms: string[]
  hints: string[]
}

/** Parses a pack file. Errors name the pack and a position, never a term. */
export function parsePack(text: string, name: string): Pack {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ConfigError(`pack "${name}" is not valid JSON`)
  }
  if (!isRecord(raw)) throw new ConfigError(`pack "${name}" must hold an object`)

  return {
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    terms: strings(raw.terms, `pack "${name}" terms`),
    hints: strings(raw.hints, `pack "${name}" hints`),
  }
}
