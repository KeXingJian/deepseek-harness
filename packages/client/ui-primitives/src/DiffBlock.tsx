import { useCallback, useMemo, useState } from 'react'
import clsx from 'clsx'
import { structuredPatch } from 'diff'
import { FoldToggle } from './FoldToggle.tsx'
import { writeClipboard } from './clipboard.ts'
import { CodeToolbar, type CodeToolbarLabels } from './CodeToolbar.tsx'
import { languageForPath } from './code-highlighting.ts'
import cardCss from './CodeCard.module.css'
import css from './DiffBlock.module.css'

/** Output lines shown before the height cap collapses the middle. */
export const DEFAULT_DIFF_MAX_LINES = 16

/**
 * One file change in the form {@link DiffBlock} renders. It is declared here
 * so this primitive stays independent of the tool contract.
 */
export interface DiffHunk {
  /** The changed file's path, drawn verbatim as the hunk's header (the tool's model-facing path). */
  path: string
  /** Prior content including context, or `null` when no prior content is available. */
  oldText: string | null
  /** Content after the change, including any shared context. */
  newText: string
}

export interface DiffBlockProps {
  /** One entry per applied hunk, in file order; empty renders nothing. */
  diffs: DiffHunk[]
  /** Localized chrome supplied by the owning render site. */
  labels: DiffBlockLabels
  /** Height cap in body lines before the middle collapses (default {@link DEFAULT_DIFF_MAX_LINES}). */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/** Localized chrome for {@link DiffBlock}. */
export interface DiffBlockLabels extends CodeToolbarLabels {
  copy: string
  copied: string
  collapseAria: string
  expandAria: (hidden: number) => string
  collapse: string
  expand: (hidden: number) => string
}

/** One aligned pair of old and new lines in a split diff. */
interface SplitDiffRow {
  kind: 'line'
  oldKind: 'del' | 'context' | 'empty'
  oldText: string
  newKind: 'add' | 'context' | 'empty'
  newText: string
}

type SplitRow = { kind: 'path'; text: string } | { kind: 'gap'; text: string } | SplitDiffRow

/** Bound synchronous edit-graph search; one replacement consumes two edits. */
const MAX_DIFF_EDIT_LENGTH = 256

/** Derive exact local patches or a whole-fragment replacement when search exceeds the limit. */
function localHunks(diff: DiffHunk) {
  const oldLines = contentLines(diff.oldText ?? '')
  const newLines = contentLines(diff.newText)
  const normalize = (lines: string[]): string => lines.map(line => `${line}\n`).join('')
  return structuredPatch('', '', normalize(oldLines), normalize(newLines),
    undefined, undefined, { context: 3, maxEditLength: MAX_DIFF_EDIT_LENGTH })?.hunks
    ?? [{ lines: [...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)] }]
}

/**
 * Count displayed additions and deletions. Exact patches exclude shared context;
 * comparisons exceeding the edit limit count both complete fragments as replaced.
 * Text follows {@link contentLines}'s terminator rule.
 * @param diffs - the hunks to count.
 * @returns the +/- totals for tool summaries.
 */
export function diffTotals(diffs: DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    for (const hunk of localHunks(diff)) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++
        if (line.startsWith('-')) removed++
      }
    }
  }
  return { added, removed }
}

/** Pair removed and added lines within each change run for side-by-side rendering. */
function buildSplitRows(diffs: DiffHunk[]): SplitRow[] {
  const rows: SplitRow[] = []
  let prevPath: string | undefined
  for (const diff of diffs) {
    rows.push({ kind: diff.path !== prevPath ? 'path' : 'gap', text: diff.path !== prevPath ? diff.path : '⋯' })
    prevPath = diff.path
    for (const [hunkIndex, hunk] of localHunks(diff).entries()) {
      if (hunkIndex > 0) rows.push({ kind: 'gap', text: '⋯' })
      let removed: string[] = []
      let added: string[] = []
      const flush = () => {
        for (let index = 0; index < Math.max(removed.length, added.length); index++) {
          const oldText = removed[index]
          const newText = added[index]
          rows.push({
            kind: 'line',
            oldKind: oldText === undefined ? 'empty' : 'del',
            oldText: oldText ?? '',
            newKind: newText === undefined ? 'empty' : 'add',
            newText: newText ?? '',
          })
        }
        removed = []
        added = []
      }
      for (const line of hunk.lines) {
        const text = line.slice(1)
        if (line.startsWith('-')) removed.push(text)
        else if (line.startsWith('+')) added.push(text)
        else {
          flush()
          rows.push({ kind: 'line', oldKind: 'context', oldText: text, newKind: 'context', newText: text })
        }
      }
      flush()
    }
  }
  return rows
}

/**
 * Split a side's text into its content lines. Empty text is zero lines (a full
 * deletion's `newText` or a create's absent `oldText` side draws nothing), and a
 * single trailing newline is a line terminator rather than an extra empty line —
 * the same terminator rule TerminalBlock applies to command output. An interior
 * blank line (a genuine `\n\n`) survives.
 * @param text - the removed or added side's text.
 * @returns the content lines, without the terminating newline.
 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * Copy the full local diff, including folded rows, with paths, context, and change prefixes.
 * @param diffs - the file changes to copy.
 * @returns the diff as plain text.
 */
function copyText(diffs: DiffHunk[]): string {
  const lines: string[] = []
  let prevPath: string | undefined
  for (const diff of diffs) {
    lines.push(diff.path !== prevPath ? diff.path : '⋯')
    prevPath = diff.path
    for (const [index, hunk] of localHunks(diff).entries()) {
      if (index > 0) lines.push('⋯')
      for (const line of hunk.lines) {
        if (line.startsWith('-')) lines.push(`- ${line.slice(1)}`)
        else if (line.startsWith('+')) lines.push(`+ ${line.slice(1)}`)
        else if (!line.startsWith('\\')) lines.push(`  ${line.slice(1)}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * Render a file mutation as an aligned two-column diff without inferred file line numbers.
 * @param props - see {@link DiffBlockProps}.
 * @returns the diff block element.
 */
export function DiffBlock({ diffs, labels, maxLines = DEFAULT_DIFF_MAX_LINES, className }: DiffBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [wrapped, setWrapped] = useState(false)
  const firstLanguage = diffs[0] === undefined ? undefined : languageForPath(diffs[0].path)
  const language = diffs.every(diff => languageForPath(diff.path) === firstLanguage) ? firstLanguage : undefined

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(copyText(diffs)).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, diffs])

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  const splitRows = useMemo(() => buildSplitRows(diffs), [diffs])
  if (splitRows.length === 0) return null

  // The cap counts aligned rows, so one replacement occupies one visible row.
  const hidden = splitRows.length - maxLines
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = maxLines - headLines
  const head = capped ? splitRows.slice(0, headLines) : splitRows
  const tail = capped ? splitRows.slice(splitRows.length - tailLines) : []
  const renderRows = (visible: SplitRow[], offset: number) => visible.map((row, index) => {
    const key = offset + index
    if (row.kind === 'path') return <div key={key} className={clsx(css.line, css.path)}>{row.text}</div>
    if (row.kind === 'gap') return <div key={key} className={clsx(css.line, css.gap)}>{row.text}</div>
    if (row.oldKind === 'context') {
      return <div key={key} className={clsx(css.line, css.context)} data-diff-side="context">{row.oldText}</div>
    }
    return (
      <div key={key} className={css.linePair}>
        <div className={clsx(css.cell, css[row.oldKind])} data-diff-side="old">{row.oldText}</div>
        <div className={clsx(css.cell, css[row.newKind])} data-diff-side="new">{row.newText}</div>
      </div>
    )
  })

  return (
    <div className={clsx(cardCss.card, css.block, className)} data-diff="" data-code-wrap={wrapped}>
      <CodeToolbar lang={language} labels={labels} copyLabel={labels.copy} copiedLabel={labels.copied}
        copied={copied} wrapped={wrapped} onCopy={onCopy} onWrap={() => { setWrapped(value => !value) }} />
      <div className={css.body}>
        {renderRows(head, 0)}
        {hidden > 0 && (
          <FoldToggle
            className={css.expand}
            expanded={expanded}
            hidden={hidden}
            labels={labels}
            onToggle={onToggle}
          />
        )}
        {renderRows(tail, splitRows.length - tail.length)}
      </div>
    </div>
  )
}
