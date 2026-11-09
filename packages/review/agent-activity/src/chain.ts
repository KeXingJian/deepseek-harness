/**
 * Projection from folded activity spans to the review-oriented execution chain.
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

import type { ActivitySpan, ChainCard, ChainResult } from './types.ts'
import { reviewFlags } from './risk.ts'

/** Tools whose calls only look around. */
const READ_TOOLS = new Set(['read', 'read_image', 'grep', 'glob', 'list', 'lsp', 'fs_search', 'web_search', 'web_fetch'])

/** Tools whose calls only search rather than open a known file. */
const SEARCH_TOOLS = new Set(['grep', 'glob', 'web_search', 'web_fetch', 'fs_search'])

/** Tools that change files. */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace', 'multi_edit', 'apply_patch'])

/** Tools that execute a command or program. */
const EXEC_TOOLS = new Set(['bash', 'exec', 'test', 'build', 'lint', 'run_code'])

/** Tools that hand control to a human. */
const INTERACT_TOOLS = new Set(['approval', 'ask_user', 'user_question'])

/** Display ceiling before older look-around cards are compressed. */
const MAX_CARDS = 30

/** Read one attribute as a string, or undefined. */
function attrString(span: ActivitySpan, key: string): string | undefined {
  const value = span.attributes?.[key]
  return typeof value === 'string' ? value : undefined
}

/** File count of one look-around card; tool look-around cards always carry it. */
/* v8 ignore next 3 -- tool look-around cards are built with numeric counts. */
function metaCount(card: ChainCard, key: 'files' | 'searches'): number {
  const value = card.meta?.[key]
  return typeof value === 'number' ? value : 0
}

/** Target path of one change card; change cards are always built with one. */
/* v8 ignore next 2 -- change cards are built with a path, so the title fallback is unreachable. */
function metaPath(card: ChainCard): string {
  return String(card.meta?.path ?? card.title)
}

/** Whole seconds a span lasted, or 0 while it runs. */
function seconds(span: ActivitySpan): number {
  return span.endTime === undefined ? 0 : Math.max(0, Math.round((span.endTime - span.startTime) / 1000))
}

/** Deterministic bigram similarity in [0, 1]; 1 means equal after normalization. */
function similarity(left: string, right: string): number {
  const a = left.replace(/\s+/g, '').toLowerCase()
  const b = right.replace(/\s+/g, '').toLowerCase()
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = (text: string): Map<string, number> => {
    const counts = new Map<string, number>()
    for (let index = 0; index < text.length - 1; index += 1) {
      const gram = text.slice(index, index + 2)
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
    }
    return counts
  }
  const leftGrams = grams(a)
  const rightGrams = grams(b)
  let overlap = 0
  for (const [gram, count] of leftGrams) overlap += Math.min(count, rightGrams.get(gram) ?? 0)
  return (2 * overlap) / (a.length - 1 + b.length - 1)
}

/** Command text of one execution span. */
function verifyCommand(span: ActivitySpan): string {
  return attrString(span, 'command') ?? span.name
}

/** File path a span changed. */
function changePath(span: ActivitySpan): string {
  return attrString(span, 'path') ?? attrString(span, 'file') ?? span.name
}

/** Compose the summary title of a look-around card. */
function reconTitle(files: number, searches: number): string {
  if (files > 0 && searches > 0) return `查看了 ${files} 个文件，检索 ${searches} 次`
  if (files > 0) return `查看了 ${files} 个文件`
  if (searches > 0) return `检索 ${searches} 次`
  return '查看'
}

/** Whether a card came from a read or search tool rather than a subagent hand-off. */
function isToolRecon(card: ChainCard): boolean {
  return card.kind === 'recon' && typeof card.meta?.tool === 'string' && card.meta.tool !== 'subagent'
}

/** Build the card one span contributes, or null when the span only supports a parent card. */
function baseCard(span: ActivitySpan): ChainCard | null {
  if (span.kind === 'turn') {
    const intent = attrString(span, 'intent')
    if (intent === undefined || intent.trim() === '') return null
    return {
      id: `intent:${span.seq}`,
      kind: 'intent',
      title: intent.trim().slice(0, 60),
      startedAt: span.startTime,
      status: 'ok',
      evidenceSeqs: [span.seq],
    }
  }

  if (span.kind === 'subagent') {
    return {
      id: `recon:${span.seq}`,
      kind: 'recon',
      title: `交给子代理：${span.name}`,
      startedAt: span.startTime,
      status: span.status === 'error' ? 'error' : 'ok',
      evidenceSeqs: [span.seq],
      meta: { tool: 'subagent' },
    }
  }

  if (span.kind === 'workflow') {
    return {
      id: `verify:${span.seq}`,
      kind: 'verify',
      title: `${span.name} ${span.status === 'error' ? '失败' : '完成'}`,
      startedAt: span.startTime,
      status: span.status === 'error' ? 'error' : 'ok',
      evidenceSeqs: [span.seq],
    }
  }

  if (span.kind !== 'tool') return null

  if (INTERACT_TOOLS.has(span.name)) {
    return {
      id: `interrupt:${span.seq}`,
      kind: 'interrupt',
      title: `请求人工确认，等待 ${seconds(span)}s`,
      startedAt: span.startTime,
      status: 'warning',
      evidenceSeqs: [span.seq],
    }
  }

  // A deletion hides inside any tool name, so it is classified before the
  // execution set; `bash rm` must not read as a verification.
  if (attrString(span, 'op') === 'delete' || span.name === 'delete') {
    const path = changePath(span)
    return {
      id: `change:${span.seq}`,
      kind: 'change',
      title: `删除 ${path}`,
      startedAt: span.startTime,
      status: 'error',
      evidenceSeqs: [span.seq],
      meta: { path, op: 'delete' },
    }
  }

  if (EXEC_TOOLS.has(span.name)) {
    const command = verifyCommand(span)
    const errorCode = attrString(span, 'errorCode')
    const failed = span.status === 'error'
    return {
      id: `verify:${span.seq}`,
      kind: 'verify',
      title: failed
        ? `${command} 失败${errorCode === undefined ? '' : `：${errorCode}`}`
        : `${command} 通过`,
      startedAt: span.startTime,
      status: failed ? 'error' : span.status === 'running' ? 'running' : 'ok',
      evidenceSeqs: [span.seq],
      meta: { command },
    }
  }

  if (WRITE_TOOLS.has(span.name)) {
    const path = changePath(span)
    const created = attrString(span, 'op') === 'create'
    return {
      id: `change:${span.seq}`,
      kind: 'change',
      title: `${created ? '新建' : '修改'} ${path}`,
      startedAt: span.startTime,
      status: 'ok',
      evidenceSeqs: [span.seq],
      meta: { path, op: created ? 'create' : 'update' },
    }
  }

  const tool = span.name
  const readsFile = READ_TOOLS.has(tool) && attrString(span, 'path') !== undefined
  return {
    id: `recon:${span.seq}`,
    kind: 'recon',
    title: tool,
    startedAt: span.startTime,
    status: 'ok',
    evidenceSeqs: [span.seq],
    meta: { tool, files: readsFile ? 1 : 0, searches: SEARCH_TOOLS.has(tool) ? 1 : 0 },
  }
}

/** Merge adjacent look-around cards into one counted summary. */
function mergeRecon(cards: readonly ChainCard[]): ChainCard[] {
  const out: ChainCard[] = []
  for (const card of cards) {
    if (!isToolRecon(card)) {
      out.push(card)
      continue
    }
    const tool = String(card.meta?.tool)
    const files = SEARCH_TOOLS.has(tool) ? 0 : metaCount(card, 'files')
    const searches = SEARCH_TOOLS.has(tool) ? 1 : 0
    const previous = out.at(-1)
    if (previous !== undefined && isToolRecon(previous)) {
      const totalFiles = metaCount(previous, 'files') + files
      const totalSearches = metaCount(previous, 'searches') + searches
      out[out.length - 1] = {
        ...previous,
        title: reconTitle(totalFiles, totalSearches),
        evidenceSeqs: [...previous.evidenceSeqs, ...card.evidenceSeqs],
        meta: { ...previous.meta, files: totalFiles, searches: totalSearches },
      }
      continue
    }
    out.push({ ...card, title: reconTitle(files, searches), meta: { ...card.meta, files, searches } })
  }
  return out
}

/** Merge change cards targeting one file; the merged card keeps the first edit's position. */
function mergeChanges(cards: readonly ChainCard[]): ChainCard[] {
  const positions = new Map<string, number>()
  const out: ChainCard[] = []
  for (const card of cards) {
    if (card.kind !== 'change') {
      out.push(card)
      continue
    }
    const path = metaPath(card)
    const existing = positions.get(path)
    const current = existing === undefined ? undefined : out[existing]
    if (existing === undefined || current === undefined) {
      positions.set(path, out.length)
      out.push(card)
      continue
    }
    positions.set(path, existing)
    out[existing] = {
      ...current,
      repeat: (current.repeat ?? 1) + 1,
      evidenceSeqs: [...current.evidenceSeqs, ...card.evidenceSeqs],
    }
  }
  return out
}

/** Keep failed verifications standalone and fold long success runs. */
function foldVerifies(cards: readonly ChainCard[]): ChainCard[] {
  const out: ChainCard[] = []
  let run: ChainCard[] = []
  const flush = (): void => {
    const first = run[0]
    if (first === undefined) return
    if (run.length < 3) {
      out.push(...run)
    } else {
      out.push({
        ...first,
        title: `验证 ${run.length} 次，全部通过`,
        evidenceSeqs: run.flatMap(card => card.evidenceSeqs),
      })
    }
    run = []
  }
  for (const card of cards) {
    if (card.kind === 'verify' && card.status === 'ok') {
      run.push(card)
      continue
    }
    flush()
    out.push(card)
  }
  flush()
  return out
}

/** Drop near-duplicate intents unless a failure or interruption forces a new one. */
function dedupeIntents(cards: readonly ChainCard[]): ChainCard[] {
  const out: ChainCard[] = []
  for (const card of cards) {
    if (card.kind !== 'intent') {
      out.push(card)
      continue
    }
    const previous = [...out].reverse().find(entry => entry.kind === 'intent')
    const last = out.at(-1)
    const forced = last?.kind === 'interrupt' || (last?.kind === 'verify' && last.status === 'error')
    if (previous !== undefined && !forced && similarity(previous.title, card.title) >= 0.8) {
      const index = out.lastIndexOf(previous)
      out[index] = { ...previous, evidenceSeqs: [...previous.evidenceSeqs, ...card.evidenceSeqs] }
      continue
    }
    out.push(card)
  }
  return out
}

/** Compress the chain below the display ceiling, look-around cards first. */
function capCards(cards: readonly ChainCard[]): ChainCard[] {
  const out = [...cards]
  while (out.length > MAX_CARDS) {
    const recons: Array<{ card: ChainCard; index: number }> = []
    out.forEach((card, index) => {
      if (card.kind === 'recon') recons.push({ card, index })
    })
    const first = recons[0]
    const second = recons[1]
    if (first !== undefined && second !== undefined) {
      out[first.index] = {
        ...first.card,
        title: '查看与检索',
        evidenceSeqs: [...first.card.evidenceSeqs, ...second.card.evidenceSeqs],
      }
      out.splice(second.index, 1)
      continue
    }
    if (first !== undefined) {
      out.splice(first.index, 1)
      continue
    }
    break
  }
  return out
}

/** Build the closing card summarizing changes and verifications. */
function resultCard(spans: readonly ActivitySpan[], cards: readonly ChainCard[]): ChainCard {
  const files = new Set(cards.filter(card => card.kind === 'change').map(card => metaPath(card)))
  const verifications = cards.filter(card => card.kind === 'verify').length
  const verified = cards.some(card => card.kind === 'verify' && card.status === 'ok')
  const last = spans.at(-1)
  return {
    id: 'result:end',
    kind: 'result',
    title: `本次改动 ${files.size} 个文件，${verifications} 次验证`,
    startedAt: last?.endTime ?? last?.startTime ?? 0,
    status: files.size > 0 && !verified ? 'error' : 'ok',
    evidenceSeqs: [],
  }
}

/**
 * Project folded activity spans into the review execution chain.
 * @param spans - collection-layer spans in ascending sequence order.
 * @param userText - the user's task text, used only by the out-of-scope heuristic.
 * @returns cards in display order and risk flags ordered by severity.
 */
export function chainFromSpans(spans: readonly ActivitySpan[], userText = ''): ChainResult {
  const ordered = [...spans].sort((left, right) => left.seq - right.seq)
  const base = ordered.map(baseCard).filter((card): card is ChainCard => card !== null)
  const merged = dedupeIntents(foldVerifies(mergeChanges(mergeRecon(base))))
  const cards = capCards([...merged, resultCard(ordered, merged)])
  const flags = reviewFlags(ordered, cards, userText)
  const flagged = new Set(flags.filter(flag => flag.code !== 'unverified').flatMap(flag => flag.evidenceFiles))
  return {
    cards: cards.map(card => card.kind === 'change'
      && card.status === 'ok'
      && flagged.has(metaPath(card))
      ? { ...card, status: 'warning' as const }
      : card),
    flags,
  }
}
