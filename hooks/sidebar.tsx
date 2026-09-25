/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
// The sidebar: a pane that shows, as the session goes, what topic-filter has
// hidden. Drawn for the person only, like `/topic-filter log`: a pane is part
// of the screen, never of what the model reads.
//
// Two tabs. Lists is a tree (list, then term, then the sources it was hidden
// in) with a three-stop control that expands it to a depth; Feed is each pass
// that hid something, newest first. Under both, bars for where hits came from.

import type { BoxProps, ButtonProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import { KIND_LABELS, plural, type FeedItem, type Summary } from './log.ts'

/** The pane's id, one per plugin. */
export const SIDEBAR_ID = 'topic-filter'

/** From this many distinct terms on, the tree starts collapsed to its lists. */
export const CONDENSE_AT = 30

/** The elements the sidebar draws with: every surface has these three. */
export type SidebarUi = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

/** How deep the tree is open: 0 lists only, 1 their terms, 2 each term's sources. */
export type Depth = 0 | 1 | 2

/**
 * What the person chose in the pane. `depth` set opens the tree to it;
 * `null` means rows were opened one by one, as `open` lists; absent, the
 * default for the summary's size.
 */
export type SidebarView = { tab: 'lists' | 'feed'; depth?: Depth | null; open: ReadonlySet<string> }

export type SidebarInput = {
  summary: Summary
  /** The subagent in view and its label, or undefined for the whole session. */
  agent?: string
  /** Counts by list only, never a word, a placeholder or a source. */
  countsOnly: boolean
  /** Filtering is paused: the pane says so above everything else. */
  isPaused?: boolean
  view: SidebarView
  /** The pane's body, in cells. */
  columns: number
  rows: number
  /** Presses on the pane's buttons; `key` is the pressed element's. */
  onPress: (key: string) => void
}

/** A tree row's id: a list, or a term within one. Also the row button's key, after `row:`. */
export const listId = (list: string) => `l/${encodeURIComponent(list)}`
export const termId = (list: string, term: string) => `t/${encodeURIComponent(list)}/${encodeURIComponent(term)}`

/** The depth the tree opens to before the person picks one. */
export const defaultDepth = (summary: Summary): Depth => (summary.terms >= CONDENSE_AT ? 0 : 1)

/** Whether a row is open in `view`. */
export function isOpen(view: SidebarView, summary: Summary, id: string): boolean {
  const depth = view.depth === undefined ? defaultDepth(summary) : view.depth
  if (depth === null) return view.open.has(id)
  return id.startsWith('l/') ? depth >= 1 : depth >= 2
}

/** Every row open in `view` now, so a press can switch from a depth to rows picked one by one. */
export function openRows(view: SidebarView, summary: Summary): Set<string> {
  const ids = summary.lists.flatMap(list => [listId(list.list), ...list.hits.map(hit => termId(list.list, hit.term))])
  return new Set(ids.filter(id => isOpen(view, summary, id)))
}

/** Short bars: the widest list's bar is this many cells. */
const MINI = 8
/** Room kept for a count at a row's end ("12 words"). */
const COUNT_WIDTH = 9
/** A term's column in the tree. */
const TERM_WIDTH = 14

/** "3 words, 2 lines": what a list or the session hid, in the person's terms. */
function counts(x: { replaced: number; dropped: number }): string {
  const parts: string[] = []
  if (x.replaced > 0) parts.push(plural(x.replaced, 'word'))
  if (x.dropped > 0) parts.push(plural(x.dropped, 'line'))
  return parts.join(', ')
}

/** `text` cut or padded to exactly `width` cells. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length > width) return width <= 3 ? text.slice(0, width) : `${text.slice(0, width - 3)}...`
  return text.padEnd(width)
}

const clock = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function sidebarView({ Box, Text, Button }: SidebarUi, input: SidebarInput): RenderElement {
  const { summary, agent, countsOnly, isPaused = false, view, onPress } = input
  const columns = Math.max(24, input.columns - 1)
  const total = summary.replaced + summary.dropped
  const isEmpty = total === 0
  const press = (key: string) => () => onPress(key)
  const top: RenderElement[] = []
  const body: RenderElement[] = []
  const bottom: RenderElement[] = []
  // Each element below is one row high (every Text truncates), so the rows
  // are counted as they are added, and the stats can sit on the pane's floor.
  let used = 0
  const add = (to: RenderElement[], element: RenderElement, rows = 1) => {
    to.push(element)
    used += rows
  }

  if (isPaused) {
    add(top, <Text key="paused" bold inverse wrap="truncate-end">{fit(' PAUSED: nothing is hidden. /topic-filter on', columns)}</Text>)
  }
  add(
    top,
    <Box key="total" flexDirection="row">
      <Text key="n" bold inverse color="claude">{` ${total.toLocaleString('en-US')} `}</Text>
      <Text key="what" bold wrap="truncate-end">{agent === undefined ? ' hidden this session' : ' hidden in this subagent'}</Text>
    </Box>,
  )
  add(
    top,
    <Text key="detail" dimColor wrap="truncate-end">
      {isEmpty ? 'Nothing yet.' : [summary.replaced > 0 ? `${plural(summary.replaced, 'word')} replaced` : '', summary.dropped > 0 ? `${plural(summary.dropped, 'line')} dropped` : ''].filter(Boolean).join(', ')}
    </Text>,
  )

  const scope = agent !== undefined ? `subagent ${agent}` : 'whole session'
  add(
    top,
    <Box key="tabs" flexDirection="row" marginTop={1} gap={2}>
      <Button key="tab:lists" plain hotkey="1" dimColor={view.tab !== 'lists'} onPress={press('tab:lists')}>Lists</Button>
      <Button key="tab:feed" plain hotkey="2" dimColor={view.tab !== 'feed'} onPress={press('tab:feed')}>Feed</Button>
      <Box key="gap" flexGrow={1} />
      <Text key="scope" dimColor wrap="truncate-start">{scope}</Text>
    </Box>,
    2,
  )

  if (view.tab === 'lists') treeRows()
  else feedRows()
  statsRows()

  // Pin the stats to the floor when everything fits; else the pane scrolls.
  const spare = input.rows - used
  return (
    <Box flexDirection="column" paddingRight={1}>
      {top}
      {body}
      {spare > 0 ? <Box key="spacer" height={spare} /> : null}
      {bottom}
    </Box>
  )

  function treeRows(): void {
    if (isEmpty) {
      add(body, <Text key="empty" dimColor>Hidden terms show here as Claude reads them.</Text>)
      return
    }
    if (!countsOnly) depthControl()
    const widest = Math.max(1, ...summary.lists.map(list => list.replaced + list.dropped))
    for (const list of summary.lists) {
      const id = listId(list.list)
      const open = !countsOnly && isOpen(view, summary, id)
      const weight = list.replaced + list.dropped
      const bar = '▮'.repeat(Math.max(1, Math.round((weight / widest) * MINI))).padEnd(MINI)
      const nameWidth = columns - 2 - MINI - 1 - COUNT_WIDTH
      const name = `${countsOnly ? ' ' : open ? '▾' : '▸'} ${fit(list.list, nameWidth)}`
      add(
        body,
        <Box key={`row-${id}`} flexDirection="row">
          {countsOnly ? (
            <Text key="name" bold>{name}</Text>
          ) : (
            <Button key={`row:${id}`} plain onPress={press(`row:${id}`)}>{name}</Button>
          )}
          <Text key="bar" color="claude">{bar}</Text>
          <Text key="n" dimColor>{counts(list).padStart(COUNT_WIDTH)}</Text>
        </Box>,
      )
      if (!open) continue
      for (const hit of list.hits) {
        const tid = termId(list.list, hit.term)
        const termOpen = isOpen(view, summary, tid)
        const shown = hit.replaced > 0 ? `-> ${hit.placeholder}` : 'line dropped'
        const n = `x${hit.replaced + hit.dropped}`
        add(
          body,
          <Box key={`row-${tid}`} flexDirection="row" paddingLeft={2}>
            <Button key={`row:${tid}`} plain onPress={press(`row:${tid}`)}>{`${termOpen ? '▾' : '▸'} ${fit(hit.term, TERM_WIDTH)}`}</Button>
            <Box key="as" flexGrow={1}>
              <Text key="as" color={hit.replaced > 0 ? 'warning' : undefined} dimColor={hit.replaced === 0} wrap="truncate-end">{` ${shown}`}</Text>
            </Box>
            <Text key="n" dimColor>{` ${n}`}</Text>
          </Box>,
        )
        if (!termOpen) continue
        for (const [i, source] of hit.sources.entries()) {
          add(body, <Text key={`src-${tid}-${i}`} dimColor wrap="truncate-end">{`       ${source.label} x${source.n}`}</Text>)
        }
      }
    }
  }

  /** `Expand ● none ──── ○ lists ──── ○ all`: the line fills up to the depth in use. */
  function depthControl(): void {
    const depth = view.depth === undefined ? defaultDepth(summary) : view.depth
    const stops: [Depth, string][] = [
      [0, 'none'],
      [1, 'lists'],
      [2, 'all'],
    ]
    const fixed = 'Expand '.length + stops.reduce((n, [, label]) => n + label.length + 3, 0)
    const line = '─'.repeat(Math.max(2, Math.floor((columns - fixed) / 2)))
    const parts: RenderElement[] = [<Text key="label" dimColor>Expand </Text>]
    for (const [n, label] of stops) {
      if (n > 0) parts.push(<Text key={`line-${n}`} color={depth !== null && depth >= n ? 'claude' : undefined} dimColor={depth === null || depth < n}>{line}</Text>)
      parts.push(
        <Button key={`depth:${n}`} plain dimColor={depth !== n} onPress={press(`depth:${n}`)}>{`${depth === n ? '●' : '○'} ${label}`}</Button>,
      )
    }
    add(body, <Box key="depth" flexDirection="row" marginBottom={1}>{parts}</Box>, 2)
  }

  function feedRows(): void {
    if (summary.feed.length === 0) {
      add(body, <Text key="empty" dimColor>Each hit shows here as it happens, newest first.</Text>)
      return
    }
    // The pane scrolls, but a feed longer than a screen or two is noise.
    for (const [i, item] of summary.feed.slice(0, Math.max(10, input.rows)).entries()) feedItem(item, i)
  }

  function feedItem(item: FeedItem, i: number): void {
    const who = agent === undefined && item.agent !== undefined ? 'Subagent: ' : ''
    const what = countsOnly ? `${who}${item.hits.length === 1 ? '1 term' : `${item.hits.length} terms`}` : `${who}${item.label}`
    const n = counts(item)
    add(
      body,
      <Box key={`feed-${i}`} flexDirection="row">
        <Text key="at" dimColor>{`${clock(item.at)} `}</Text>
        <Box key="what" flexGrow={1}>
          <Text key="what" wrap="truncate-end">{what}</Text>
        </Box>
        <Text key="n" dimColor>{` ${n}`}</Text>
      </Box>,
    )
    const lists = [...new Set(item.hits.map(hit => hit.list))]
    const detail = countsOnly
      ? lists.join(', ')
      : lists.map(list => `${list}: ${item.hits.filter(hit => hit.list === list).map(hit => `${hit.term} x${hit.n}`).join(', ')}`).join('; ')
    add(body, <Text key={`feed-${i}-hits`} dimColor wrap="truncate-end">{`      ${detail}`}</Text>)
  }

  function statsRows(): void {
    if (isEmpty) return
    add(bottom, <Text key="rule" dimColor>{'─'.repeat(columns)}</Text>, 2)
    add(
      bottom,
      <Box key="where" flexDirection="row">
        <Box key="title" flexGrow={1}>
          <Text key="title" bold>Where it came from</Text>
        </Box>
        {summary.lastAt === undefined ? null : <Text key="last" dimColor>{`last hit ${clock(summary.lastAt)}`}</Text>}
      </Box>,
    )
    const most = Math.max(1, ...summary.kinds.map(k => k.n))
    const width = Math.max(4, columns - 12 - 5)
    for (const { kind, n } of summary.kinds) {
      const fill = Math.max(1, Math.round((n / most) * width))
      add(
        bottom,
        <Box key={`kind-${kind}`} flexDirection="row">
          <Text key="label">{fit(KIND_LABELS[kind], 12)}</Text>
          <Text key="fill" color="claude">{'█'.repeat(fill)}</Text>
          {fill < width ? <Text key="track" dimColor>{'░'.repeat(width - fill)}</Text> : null}
          <Text key="n" dimColor>{String(n).padStart(5)}</Text>
        </Box>,
      )
    }
    const facts: [number, string][] = [
      [summary.terms, 'term'],
      [summary.lists.length, 'list'],
      [summary.sources, 'source'],
    ]
    if (agent === undefined && summary.agents.length > 0) facts.push([summary.agents.length, 'subagent'])
    add(
      bottom,
      <Box key="facts" flexDirection="row" gap={2} marginTop={1}>
        {facts.map(([n, noun]) => (
          <Text key={noun} dimColor>{plural(n, noun)}</Text>
        ))}
      </Box>,
      2,
    )
  }
}
