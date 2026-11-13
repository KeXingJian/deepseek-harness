import { useCallback, useMemo, useState } from 'react'
import clsx from 'clsx'
import { structuredPatch } from 'diff'
import refractor from 'refractor'
import { Diff, Hunk, markEdits, tokenize } from 'react-diff-view'
import type { ChangeData, DiffType, HunkData, HunkTokens } from 'react-diff-view'
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

/** Prism/refractor language ids for the few Shiki ids whose name differs. */
const REFRACTOR_ALIASES: Readonly<Record<string, string>> = {
  shellscript: 'bash',
  html: 'markup',
  xml: 'markup',
  bat: 'batch',
  make: 'makefile',
  proto: 'protobuf',
  'system-verilog': 'systemverilog',
}

/**
 * Resolve a file path to a refractor language id, or `undefined` when the path
 * maps to no registered grammar. Unknown languages fall back to plain text with
 * inline edit marks, never an error.
 * @param path - the changed file's path.
 * @returns the refractor language id, or `undefined`.
 */
function refractorLanguage(path: string): string | undefined {
  const language = languageForPath(path)
  if (language === undefined) return undefined
  if (refractor.registered(language)) return language
  const alias = REFRACTOR_ALIASES[language]
  return alias !== undefined && refractor.registered(alias) ? alias : undefined
}

/** One file's prepared diff: parsed hunks, the flat change list, tokens, and kind. */
interface PreparedEntry {
  readonly path: string
  readonly changes: readonly ChangeData[]
  readonly tokens: HunkTokens | null
  readonly diffType: DiffType
}

/** A run of kept changes from one entry, rebuilt as a single hunk for rendering. */
type DiffSegment = { readonly kind: 'diff'; readonly key: string; readonly entry: PreparedEntry; readonly changes: ChangeData[] }

/**
 * Build react-diff-view hunks straight from {@link structuredPatch}'s output,
 * assigning the same per-change line numbers the token lookup
 * (`tokens.old[lineNumber - 1]`) reads. Generating the patch text and re-parsing
 * it through gitdiff-parser is avoided: `createTwoFilesPatch` emits `Index:` and
 * `===` header lines plus a second `---`/`+++` pair that gitdiff-parser reads as
 * change lines before any `@@` hunk, which crashes the parse.
 * @param diff - the recorded hunk.
 * @returns the parsed hunks in react-diff-view's `HunkData` form.
 */
function hunksFromDiff(diff: DiffHunk): HunkData[] {
  const patch = structuredPatch('', '', diff.oldText ?? '', diff.newText, undefined, undefined,
    { context: 3, maxEditLength: MAX_DIFF_EDIT_LENGTH })
  if (patch === undefined) return []
  return patch.hunks.map((hunk) => {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    const changes: ChangeData[] = []
    for (const line of hunk.lines) {
      if (line[0] === ' ') {
        changes.push({ type: 'normal', content: line.slice(1), isNormal: true, oldLineNumber: oldLine++, newLineNumber: newLine++ })
      } else if (line[0] === '-') {
        changes.push({ type: 'delete', content: line.slice(1), isDelete: true, lineNumber: oldLine++ })
      } else if (line[0] === '+') {
        changes.push({ type: 'insert', content: line.slice(1), isInsert: true, lineNumber: newLine++ })
      }
      // The `\ No newline at end of file` marker contributes no change.
    }
    return { content: '', oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, changes }
  })
}

/**
 * Parse one recorded hunk into react-diff-view hunks and tokenize them for
 * syntax highlighting plus word-level inline edit marks. Each entry is prepared
 * independently so its line numbers stay self-consistent, which the token
 * lookup (`tokens.old[lineNumber - 1]`) relies on.
 * @param diff - the recorded hunk.
 * @returns the prepared entry.
 */
function prepareEntry(diff: DiffHunk): PreparedEntry {
  const hunks = hunksFromDiff(diff)
  const changes = hunks.flatMap(hunk => hunk.changes)
  const language = refractorLanguage(diff.path)
  const tokens = changes.length === 0
    ? null
    : tokenize(hunks, language === undefined
      ? { enhancers: [markEdits(hunks)] }
      : { highlight: true, refractor, language, enhancers: [markEdits(hunks)] })
  const diffType: DiffType = diff.oldText === null ? 'add' : diff.newText === '' ? 'delete' : 'modify'
  return { path: diff.path, changes, tokens, diffType }
}

/** One rendered row: a file header, a same-file separator, the fold toggle, or a diff run. */
type Segment =
  | { readonly kind: 'path'; readonly path: string; readonly key: string }
  | { readonly kind: 'gap'; readonly key: string }
  | { readonly kind: 'toggle'; readonly key: string }
  | DiffSegment

/**
 * Lay out the prepared entries as render segments, grouping each entry's kept
 * changes into contiguous diff runs. The head/tail cap keeps the first and last
 * `maxLines` changes and drops the middle, with the fold toggle at the boundary.
 * @param entries - the prepared entries in file order.
 * @param kept - per-change keep flags over the flattened change list, or `null` to keep all.
 * @param headCount - the number of leading changes kept when capped.
 * @returns the ordered render segments.
 */
function buildSegments(entries: readonly PreparedEntry[], kept: readonly boolean[] | null, headCount: number): Segment[] {
  const segments: Segment[] = []
  let flatIndex = 0
  let prevPath: string | undefined
  let togglePlaced = false
  let segmentId = 0
  for (const entry of entries) {
    if (entry.path !== prevPath) {
      segments.push({ kind: 'path', path: entry.path, key: `path-${segmentId++}` })
      prevPath = entry.path
    } else {
      segments.push({ kind: 'gap', key: `gap-${segmentId++}` })
    }
    let run: ChangeData[] = []
    const flush = () => {
      if (run.length > 0) {
        segments.push({ kind: 'diff', key: `diff-${segmentId++}`, entry, changes: run })
        run = []
      }
    }
    for (const change of entry.changes) {
      const keep = kept === null || kept[flatIndex]
      if (kept !== null && !togglePlaced && flatIndex === headCount) {
        flush()
        segments.push({ kind: 'toggle', key: 'toggle' })
        togglePlaced = true
      }
      if (keep) run.push(change)
      else flush()
      flatIndex++
    }
    flush()
  }
  return segments
}

/**
 * Render a file mutation as a GitHub-style side-by-side diff: syntax-highlighted
 * lines with word-level inline edit marks, a split view without line numbers,
 * and a head-tail fold past the height cap.
 * @param props - see {@link DiffBlockProps}.
 * @returns the diff block element.
 */
export function DiffBlock({ diffs, labels, maxLines = DEFAULT_DIFF_MAX_LINES, className }: DiffBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [wrapped, setWrapped] = useState(true)
  const firstLanguage = diffs[0] === undefined ? undefined : languageForPath(diffs[0].path)
  const language = diffs.every(diff => languageForPath(diff.path) === firstLanguage) ? firstLanguage : undefined

  const entries = useMemo(() => diffs.map(prepareEntry), [diffs])
  const total = entries.reduce((sum, entry) => sum + entry.changes.length, 0)
  const hidden = total - maxLines
  const capped = hidden > 0 && !expanded
  const headCount = Math.ceil(maxLines / 2)
  const kept = useMemo(() => {
    if (!capped) return null
    const tailCount = maxLines - headCount
    return Array.from({ length: total }, (_v, index) => index < headCount || index >= total - tailCount)
  }, [capped, total, headCount, maxLines])
  const segments = useMemo(() => buildSegments(entries, kept, headCount), [entries, kept, headCount])

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(copyText(diffs)).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, diffs])

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  if (total === 0) return null

  return (
    <div className={clsx(cardCss.card, css.block, className)} data-diff="" data-code-wrap={wrapped}>
      <CodeToolbar lang={language} labels={labels} copyLabel={labels.copy} copiedLabel={labels.copied}
        copied={copied} wrapped={wrapped} onCopy={onCopy} onWrap={() => { setWrapped(value => !value) }} />
      <div className={css.body}>
        {segments.map((segment) => {
          if (segment.kind === 'path') {
            return <div key={segment.key} className={css.path}>{segment.path}</div>
          }
          if (segment.kind === 'gap') {
            return <div key={segment.key} className={css.gap}>⋯</div>
          }
          if (segment.kind === 'toggle') {
            return (
              <FoldToggle
                key={segment.key}
                className={css.expand}
                expanded={expanded}
                hidden={hidden}
                labels={labels}
                onToggle={onToggle}
              />
            )
          }
          const hunks: HunkData[] = [{ content: '', oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, changes: segment.changes }]
          return (
            <Diff
              key={segment.key}
              diffType={segment.entry.diffType}
              viewType="split"
              gutterType="none"
              hunks={hunks}
              tokens={segment.entry.tokens}
            >
              {hs => hs.map((hunk, index) => <Hunk key={index} hunk={hunk} />)}
            </Diff>
          )
        })}
      </div>
    </div>
  )
}
