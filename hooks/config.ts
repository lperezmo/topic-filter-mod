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
  /** A GitHub repository topic whose repositories join `terms` at session start. */
  githubTopic?: string
  /** A topic pack whose terms join `terms`: the user's own file first, else the built-in one. */
  pack?: string
  /** Terms left out of this list, whatever brought them in (the pack, the GitHub topic, `terms`). */
  exclude: string[]
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

  const githubTopic = list.githubTopic
  if (githubTopic !== undefined && (typeof githubTopic !== 'string' || !SLUG.test(githubTopic))) {
    throw new ConfigError(`${at}.githubTopic must be a GitHub topic (lowercase letters, digits, hyphens)`)
  }

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
    githubTopic,
    pack,
    exclude: strings(list.exclude, `${at}.exclude`),
  }
}

/** A GitHub topic or pack name: also safe as a file name, never a path. */
export const SLUG = /^[a-z0-9][a-z0-9-]*$/

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
