/**
 * 从折叠后的活动跨度到面向评审的执行链的投影。
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

import type { ActivitySpan, ChainCard, ChainResult, ChainTitle } from './types.ts'
import { reviewFlags } from './risk.ts'

/** 其调用仅做探查的工具。 */
const READ_TOOLS = new Set(['read', 'read_image', 'grep', 'glob', 'list', 'lsp', 'fs_search', 'web_search', 'web_fetch'])

/** 其调用只做搜索、而不打开已知文件的工具。 */
const SEARCH_TOOLS = new Set(['grep', 'glob', 'web_search', 'web_fetch', 'fs_search'])

/** 会修改文件的工具。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace', 'multi_edit', 'apply_patch'])

/** 会执行命令或程序的工具。 */
const EXEC_TOOLS = new Set(['bash', 'exec', 'test', 'build', 'lint', 'run_code'])

/** 将控制权交给人的工具。 */
const INTERACT_TOOLS = new Set(['approval', 'ask_user', 'user_question'])

/** 较早的探查卡片被压缩前的展示上限。 */
const MAX_CARDS = 30

/** 将一个属性读作字符串；不存在时返回 undefined。 */
function attrString(span: ActivitySpan, key: string): string | undefined {
  const value = span.attributes?.[key]
  return typeof value === 'string' ? value : undefined
}

/** 一张探查卡片的文件计数；工具探查卡片总是带有该值。 */
/* v8 ignore next 3 -- 工具探查卡片在构建时总会带上数值计数。 */
function metaCount(card: ChainCard, key: 'files' | 'searches'): number {
  const value = card.meta?.[key]
  return typeof value === 'number' ? value : 0
}

/** 一张变更卡片的目标路径；变更卡片总是带有变更标题。 */
function metaPath(card: ChainCard): string {
  /* v8 ignore next -- 到达此辅助函数的每张卡片都按变更卡片构建。 */
  return card.title.copy === 'change' ? card.title.path : ''
}

/** 跨度持续的总秒数；跨度仍在运行时为 0。 */
function seconds(span: ActivitySpan): number {
  return span.endTime === undefined ? 0 : Math.max(0, Math.round((span.endTime - span.startTime) / 1000))
}

/** 确定性的二元组相似度，取值在 [0, 1]；为 1 表示归一化后完全相同。 */
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

/** 单次执行跨度的命令文本。 */
function verifyCommand(span: ActivitySpan): string {
  return attrString(span, 'command') ?? span.name
}

/** 该跨度变更的文件路径。 */
function changePath(span: ActivitySpan): string {
  return attrString(span, 'path') ?? attrString(span, 'file') ?? span.name
}

/** 覆盖给定总计的探查卡片汇总标题。 */
function reconTitle(files: number, searches: number): ChainTitle {
  return { copy: 'recon', files, searches }
}

/** 卡片是否来自读取或搜索工具，而非子代理交接。 */
function isToolRecon(card: ChainCard): boolean {
  return card.title.copy === 'recon'
}

/** 构建一个跨度所贡献的卡片；当该跨度仅支撑父卡片时返回 null。 */
function baseCard(span: ActivitySpan): ChainCard | null {
  if (span.kind === 'turn') {
    const intent = attrString(span, 'intent')
    if (intent === undefined || intent.trim() === '') return null
    return {
      id: `intent:${span.seq}`,
      kind: 'intent',
      title: { copy: 'intent', text: intent.trim().slice(0, 60) },
      startedAt: span.startTime,
      status: 'ok',
      evidenceSeqs: [span.seq],
    }
  }

  if (span.kind === 'subagent') {
    return {
      id: `recon:${span.seq}`,
      kind: 'recon',
      title: { copy: 'subagent', name: span.name },
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
      title: span.status === 'error'
        ? { copy: 'workflowFailed', name: span.name }
        : { copy: 'workflowCompleted', name: span.name },
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
      title: { copy: 'interrupt', seconds: seconds(span) },
      startedAt: span.startTime,
      status: 'warning',
      evidenceSeqs: [span.seq],
    }
  }

  // 删除可能藏在任意工具名下，因此要在执行类集合之前分类；`bash rm` 不得被
  // 读作一次校验。
  if (attrString(span, 'op') === 'delete' || span.name === 'delete') {
    const path = changePath(span)
    return {
      id: `change:${span.seq}`,
      kind: 'change',
      title: { copy: 'change', op: 'delete', path },
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
        ? { copy: 'verifyFailed', command, ...errorCode === undefined ? {} : { errorCode } }
        : { copy: 'verifyPassed', command },
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
      title: { copy: 'change', op: created ? 'create' : 'update', path },
      startedAt: span.startTime,
      status: 'ok',
      evidenceSeqs: [span.seq],
      meta: { path, op: created ? 'create' : 'update' },
    }
  }

  const tool = span.name
  // 搜索工具即使打开了文件也只计为一次搜索；单张卡片的总计不得取决于它之后
  // 是否会与相邻卡片合并。
  const files = SEARCH_TOOLS.has(tool) ? 0 : READ_TOOLS.has(tool) && attrString(span, 'path') !== undefined ? 1 : 0
  const searches = SEARCH_TOOLS.has(tool) ? 1 : 0
  return {
    id: `recon:${span.seq}`,
    kind: 'recon',
    title: reconTitle(files, searches),
    startedAt: span.startTime,
    status: 'ok',
    evidenceSeqs: [span.seq],
    meta: { tool, files, searches },
  }
}

/** 把相邻的探查卡片合并为一张带计数的汇总卡片。 */
function mergeRecon(cards: readonly ChainCard[]): ChainCard[] {
  const out: ChainCard[] = []
  for (const card of cards) {
    const previous = out.at(-1)
    if (!isToolRecon(card) || previous === undefined || !isToolRecon(previous)) {
      out.push(card)
      continue
    }
    const files = metaCount(previous, 'files') + metaCount(card, 'files')
    const searches = metaCount(previous, 'searches') + metaCount(card, 'searches')
    out[out.length - 1] = {
      ...previous,
      title: reconTitle(files, searches),
      evidenceSeqs: [...previous.evidenceSeqs, ...card.evidenceSeqs],
      meta: { ...previous.meta, files, searches },
    }
  }
  return out
}

/** 合并指向同一文件的变更卡片；合并后的卡片保留首次编辑的位置。 */
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

/** 失败的校验保持独立，较长的连续成功校验则折叠。 */
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
        title: { copy: 'verifyRun', count: run.length },
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

/** 意图卡片原样展示的文本。 */
function intentText(card: ChainCard): string {
  /* v8 ignore next -- dedupeIntents 只比较意图卡片，因此始终走记录文本这一分支。 */
  return card.title.copy === 'intent' ? card.title.text : ''
}

/** 丢弃近似重复的意图，除非失败或中断强制产生新的意图。 */
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
    if (previous !== undefined && !forced && similarity(intentText(previous), intentText(card)) >= 0.8) {
      const index = out.lastIndexOf(previous)
      out[index] = { ...previous, evidenceSeqs: [...previous.evidenceSeqs, ...card.evidenceSeqs] }
      continue
    }
    out.push(card)
  }
  return out
}

/** 将链路压缩到展示上限以内，优先压缩探查卡片。 */
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
        title: { copy: 'reconCollapsed' },
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

/** 构建汇总变更与校验的收尾卡片。 */
function resultCard(spans: readonly ActivitySpan[], cards: readonly ChainCard[]): ChainCard {
  const files = new Set(cards.filter(card => card.kind === 'change').map(card => metaPath(card)))
  const verifications = cards.filter(card => card.kind === 'verify').length
  const verified = cards.some(card => card.kind === 'verify' && card.status === 'ok')
  const last = spans.at(-1)
  return {
    id: 'result:end',
    kind: 'result',
    title: { copy: 'result', files: files.size, verifications },
    startedAt: last?.endTime ?? last?.startTime ?? 0,
    status: files.size > 0 && !verified ? 'error' : 'ok',
    evidenceSeqs: [],
  }
}

/**
 * 将折叠后的活动跨度投影为评审执行链。
 * @param spans - 采集层的跨度，按序号升序排列。
 * @param userText - 用户的任务文本，仅用于范围外启发式判断。
 * @returns 按展示顺序排列的卡片，以及按严重程度排序的风险标记。
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
