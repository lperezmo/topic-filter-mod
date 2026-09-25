/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
// The sidebar: a pane that shows, as the session goes, what topic-filter has
// hidden. Drawn for the person only, like `/topic-filter log`: a pane is part
// of the screen, never of what the model reads.

import type { BoxProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import { plural, type Summary } from './log.ts'
import type { Hit } from './redact.ts'

/** The pane's id, one per plugin. */
export const SIDEBAR_ID = 'topic-filter'

/** From this many distinct terms on, the sidebar counts by list instead of naming each term. */
export const CONDENSE_AT = 30

/** The elements the sidebar draws with: every surface has these two. */
export type SidebarUi = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps> }

export type SidebarInput = {
  summary: Summary
  /** The subagent in view and its label, or undefined for the whole session. */
  agent?: string
  /** Counts by list only, never a word, a placeholder or a source. */
  countsOnly: boolean
  /** Filtering is paused: the pane says so above everything else. */
  isPaused?: boolean
}

/** "3 words, 2 lines": what a list or the session hid, in the person's terms. */
function counts(x: { replaced: number; dropped: number }): string {
  const parts: string[] = []
  if (x.replaced > 0) parts.push(plural(x.replaced, 'word'))
  if (x.dropped > 0) parts.push(`${plural(x.dropped, 'line')} dropped`)
  return parts.join(', ')
}

/** One term's row: its placeholder when it was replaced, and the lines it dropped. */
function hitRow(hit: Hit): string {
  const parts: string[] = []
  if (hit.replaced > 0) parts.push(`-> ${hit.placeholder} x${hit.replaced}`)
  if (hit.dropped > 0) parts.push(`${plural(hit.dropped, 'line')} dropped`)
  return `  ${hit.term} ${parts.join(', ')}`
}

export function sidebarView({ Box, Text }: SidebarUi, { summary, agent, countsOnly, isPaused = false }: SidebarInput): RenderElement {
  const isEmpty = summary.replaced + summary.dropped === 0
  const isCondensed = countsOnly || summary.terms >= CONDENSE_AT
  const scope =
    agent !== undefined
      ? `Subagent: ${agent}`
      : summary.agents.length > 0
        ? `Whole session, ${plural(summary.agents.length, 'subagent')} included`
        : 'Whole session'

  return (
    <Box flexDirection="column" paddingRight={1}>
      {isPaused ? (
        <Text key="paused" bold inverse wrap="truncate-end">
          {' PAUSED: nothing is hidden. /topic-filter on '}
        </Text>
      ) : null}
      <Text key="total" bold wrap="truncate-end">
        {isEmpty ? 'Nothing hidden yet' : `Hidden: ${counts(summary)}`}
      </Text>
      <Text key="scope" dimColor wrap="truncate-end">
        {scope}
      </Text>
      {summary.lists.map((list, i) =>
        isCondensed ? (
          <Box key={`list-${i}`} marginTop={i === 0 ? 1 : 0}>
            <Text key={`list-${i}-text`} wrap="truncate-end">
              {`${list.list}: ${counts(list)} (${plural(list.hits.length, 'term')})`}
            </Text>
          </Box>
        ) : (
          <Box key={`list-${i}`} flexDirection="column" marginTop={1}>
            <Text key={`list-${i}-text`} bold wrap="truncate-end">
              {list.list}
            </Text>
            {list.hits.map((hit, j) => (
              <Text key={`hit-${i}-${j}`} wrap="truncate-end">
                {hitRow(hit)}
              </Text>
            ))}
          </Box>
        ),
      )}
      {isCondensed && !countsOnly && !isEmpty ? (
        <Box marginTop={1}>
          <Text key="note" dimColor wrap="wrap">
            {`${CONDENSE_AT}+ terms, so counted by list. /topic-filter log names each one.`}
          </Text>
        </Box>
      ) : null}
      {!countsOnly && summary.latest !== undefined ? (
        <Box marginTop={1}>
          <Text key="latest" dimColor wrap="truncate-end">
            {`Latest: ${summary.latest}`}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
