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

  const terms = list.terms ?? []
  if (!Array.isArray(terms)) throw new ConfigError(`${at}.terms must be an array`)
  terms.forEach((term, j) => {
    if (typeof term !== 'string') throw new ConfigError(`${at}.terms[${j}] must be a string`)
  })

  const githubTopic = list.githubTopic
  if (githubTopic !== undefined && (typeof githubTopic !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(githubTopic))) {
    throw new ConfigError(`${at}.githubTopic must be a GitHub topic (lowercase letters, digits, hyphens)`)
  }

  return {
    name: typeof list.name === 'string' ? list.name : `list ${i + 1}`,
    mode: oneOf(list.mode, ['replace', 'drop-line'] as const, 'replace', `${at}.mode`),
    match: oneOf(list.match, ['word', 'substring'] as const, 'word', `${at}.match`),
    restore: flag(list.restore, false, `${at}.restore`),
    terms: terms as string[],
    githubTopic,
  }
}
