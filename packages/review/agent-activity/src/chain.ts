/**
 * 从折叠后的活动跨度到面向评审的执行链的投影。
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

import type { ActivitySpan, ChainActions, ChainCard, ChainDiff, ChainResult, ChainTitle } from './types.ts'
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

/** 记录文本在卡片标题中保留的字符数；原文仍在展开视图里。 */
const TITLE_LIMIT = 60

/**
 * 按工具调用标识索引的差异块。
 *
 * 差异块是记录下来的会话事实（变更前后的原文），不是跨度能自行推导的属性：
 * 折叠层不把文件文本写进跨度属性，因此链投影通过这个参数接收它们，而不是让
 * 采集层为每条改动跨度复制一份文件内容。
 */
export type ChangeDiffs = Readonly<Record<string, readonly ChainDiff[]>>

/** 没有记录任何差异时的默认输入。 */
const NO_DIFFS: ChangeDiffs = {}

/** 将一个属性读作字符串；不存在时返回 undefined。 */
function attrString(span: ActivitySpan, key: string): string | undefined {
  const value = span.attributes?.[key]
  return typeof value === 'string' ? value : undefined
}

/** 将一个属性读作数字；不存在或不是数字时返回 undefined。 */
function attrNumber(span: ActivitySpan, key: string): number | undefined {
  const value = span.attributes?.[key]
  return typeof value === 'number' ? value : undefined
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

/** 一个回合贡献的卡片：先是用户提示词，再是助手意图。 */
function turnCards(span: ActivitySpan): ChainCard[] {
  const cards: ChainCard[] = []
  const prompt = attrString(span, 'prompt')
  if (prompt !== undefined && prompt.trim() !== '') {
    const text = prompt.trim()
    // 提示词卡片核对的是写下它的那条用户消息，而不是回合的开启事件。
    const seq = attrNumber(span, 'promptSeq') ?? span.seq
    cards.push({
      id: `prompt:${seq}`,
      kind: 'prompt',
      title: { copy: 'prompt', text: text.slice(0, TITLE_LIMIT) },
      startedAt: span.startTime,
      status: 'ok',
      evidenceSeqs: [seq],
      meta: { prompt: text },
    })
  }
  const intent = attrString(span, 'intent')
  if (intent !== undefined && intent.trim() !== '') {
    cards.push({
      id: `intent:${span.seq}`,
      kind: 'intent',
      title: { copy: 'intent', text: intent.trim().slice(0, TITLE_LIMIT) },
      startedAt: span.startTime,
      status: 'ok',
      evidenceSeqs: [span.seq],
    })
  }
  return cards
}

/**
 * 一步思考对应的卡片：标题是思考首句，展开显示思考原文。
 * @param span - 该步骤的跨度。
 * @param thinking - 该步骤记录的思考原文，非空。
 * @param actions - 该步骤触发的行动计数；没有可计入的行动时为 undefined。
 * @returns 思考卡片。
 */
function thinkingCard(span: ActivitySpan, thinking: string, actions: ChainActions | undefined): ChainCard {
  // 思考属于写下它的那条助手消息，而不是步骤的开启事件。
  const seq = attrNumber(span, 'thinkingSeq') ?? span.seq
  return {
    id: `thinking:${seq}`,
    kind: 'thinking',
    title: { copy: 'thinking', text: thinking.replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT) },
    startedAt: span.startTime,
    status: 'ok',
    evidenceSeqs: [seq],
    ...(actions === undefined ? {} : { actions }),
    meta: { thinking },
  }
}

/** 一个步骤贡献的卡片：只有记录过思考的步骤才出卡。 */
function stepCards(span: ActivitySpan, actions: ChainActions | undefined): ChainCard[] {
  const thinking = attrString(span, 'thinking')
  if (thinking === undefined || thinking.trim() === '') return []
  return [thinkingCard(span, thinking.trim(), actions)]
}

/** 工具跨度在链上的归类；未知工具按探查处理。 */
function toolAction(span: ActivitySpan): 'interrupt' | 'change' | 'verify' | 'recon' {
  if (INTERACT_TOOLS.has(span.name)) return 'interrupt'
  // 删除可能藏在任意工具名下，因此要在执行类集合之前分类；`bash rm` 不得被
  // 读作一次校验。
  if (attrString(span, 'op') === 'delete' || span.name === 'delete') return 'change'
  if (EXEC_TOOLS.has(span.name)) return 'verify'
  if (WRITE_TOOLS.has(span.name)) return 'change'
  return 'recon'
}

/** 一次将控制权交给人的工具调用。 */
function interruptCard(span: ActivitySpan): ChainCard {
  return {
    id: `interrupt:${span.seq}`,
    kind: 'interrupt',
    title: { copy: 'interrupt', seconds: seconds(span) },
    startedAt: span.startTime,
    status: 'warning',
    evidenceSeqs: [span.seq],
  }
}

/**
 * 一次工具调用记录的差异块。
 * @param span - 该次调用自身的跨度。
 * @param diffs - 调用方传入的记录差异，按调用标识索引。
 * @returns 记录的差异块；该调用没有记录、或记录为空时为 undefined。
 */
function recordedDiffs(span: ActivitySpan, diffs: ChangeDiffs): readonly ChainDiff[] | undefined {
  const callId = attrString(span, 'callId')
  if (callId === undefined) return undefined
  const recorded = diffs[callId]
  return Array.isArray(recorded) && recorded.length > 0 ? recorded : undefined
}

/** 一次文件创建、修改或删除；删除用 error 状态标出。 */
function changeCard(span: ActivitySpan, diffs: ChangeDiffs): ChainCard {
  const path = changePath(span)
  const recorded = recordedDiffs(span, diffs)
  const recordedField = recorded === undefined ? {} : { diffs: recorded }
  if (attrString(span, 'op') === 'delete' || span.name === 'delete') {
    return {
      id: `change:${span.seq}`,
      kind: 'change',
      title: { copy: 'change', op: 'delete', path },
      startedAt: span.startTime,
      status: 'error',
      evidenceSeqs: [span.seq],
      ...recordedField,
      meta: { path, op: 'delete' },
    }
  }
  const created = attrString(span, 'op') === 'create'
  return {
    id: `change:${span.seq}`,
    kind: 'change',
    title: { copy: 'change', op: created ? 'create' : 'update', path },
    startedAt: span.startTime,
    status: 'ok',
    evidenceSeqs: [span.seq],
    ...recordedField,
    meta: { path, op: created ? 'create' : 'update' },
  }
}

/** 一条命令的执行结果。 */
function verifyCard(span: ActivitySpan): ChainCard {
  const command = verifyCommand(span)
  const errorCode = attrString(span, 'errorCode')
  const failed = span.status === 'error'
  return {
    id: `verify:${span.seq}`,
    kind: 'verify',
    title: failed
      ? { copy: 'verifyFailed', command, ...(errorCode === undefined ? {} : { errorCode }) }
      : { copy: 'verifyPassed', command },
    startedAt: span.startTime,
    status: failed ? 'error' : span.status === 'running' ? 'running' : 'ok',
    evidenceSeqs: [span.seq],
    meta: { command },
  }
}

/** 一次读取、检索或未知工具的调用，计为探查。 */
function reconCard(span: ActivitySpan): ChainCard {
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

/** 一份全零的行动计数。 */
const NO_ACTIONS: ChainActions = { files: 0, searches: 0, changes: 0, verifications: 0 }

/** 一次工具调用计入所在步骤的行动计数。 */
function actionContribution(span: ActivitySpan): ChainActions {
  const action = toolAction(span)
  if (action === 'interrupt') return NO_ACTIONS
  if (action === 'change') return { ...NO_ACTIONS, changes: 1 }
  if (action === 'verify') return { ...NO_ACTIONS, verifications: 1 }
  const searches = SEARCH_TOOLS.has(span.name) ? 1 : 0
  const files = SEARCH_TOOLS.has(span.name) ? 0 : attrString(span, 'path') !== undefined ? 1 : 0
  return { ...NO_ACTIONS, files, searches }
}

/**
 * 每个步骤跨度序号对应的行动计数。
 *
 * 步骤的跨度按序号先于它触发的工具调用，因此扫描一遍就能把工具归到最近的步骤，
 * 直到下一条回合或步骤跨度为止。
 * @param spans - 按序号升序排列的跨度。
 * @returns 只包含有可计入行动的步骤；计数全为零的步骤不出现。
 */
function stepActionCounts(spans: readonly ActivitySpan[]): Map<number, ChainActions> {
  const counts = new Map<number, ChainActions>()
  let step: number | undefined
  for (const span of spans) {
    if (span.kind === 'turn') {
      step = undefined
      continue
    }
    if (span.kind === 'step') {
      step = span.seq
      continue
    }
    if (span.kind !== 'tool' || step === undefined) continue
    const current = counts.get(step) ?? NO_ACTIONS
    const add = actionContribution(span)
    const merged = {
      files: current.files + add.files,
      searches: current.searches + add.searches,
      changes: current.changes + add.changes,
      verifications: current.verifications + add.verifications,
    }
    if (merged.files + merged.searches + merged.changes + merged.verifications > 0) counts.set(step, merged)
  }
  return counts
}

/**
 * 每个工具调用所属的步骤跨度序号。
 *
 * 工具跨度由它所属的步骤开启，因此最近一条步骤跨度就是它的所有者；回合边界
 * 清空归属，步骤之外发生的调用没有归属。
 * @param spans - 按序号升序排列的跨度。
 * @returns 工具调用序号到所属步骤序号的映射。
 */
function stepOwnership(spans: readonly ActivitySpan[]): Map<number, number> {
  const owner = new Map<number, number>()
  let step: number | undefined
  for (const span of spans) {
    if (span.kind === 'turn') {
      step = undefined
      continue
    }
    if (span.kind === 'step') {
      step = span.seq
      continue
    }
    if (span.kind === 'tool' && step !== undefined) owner.set(span.seq, step)
  }
  return owner
}

/** 一层卡片共用的合并顺序：先合计数，再合目标，最后收敛计划与校验。 */
function mergeLevel(cards: readonly ChainCard[]): ChainCard[] {
  return dedupeIntents(foldVerifies(mergeChanges(mergeRecon(cards))))
}

/**
 * 平铺卡片，并把每条思考卡片所属步骤的行动卡片挂到它下面。
 *
 * 行动是这段思考的直接结果，因此归到思考卡片下；没有记录思考的步骤没有可归属
 * 的对象，它的行动卡片留在链上平铺。
 * @param spans - 按序号升序排列的跨度。
 * @param actions - 每个步骤的行动计数。
 * @param diffs - 记录的差异块。
 * @returns 顶层卡片；思考卡片带有它的行动子卡。
 */
function assembleCards(
  spans: readonly ActivitySpan[],
  actions: ReadonlyMap<number, ChainActions>,
  diffs: ChangeDiffs,
): ChainCard[] {
  const owner = stepOwnership(spans)
  const top: ChainCard[] = []
  // 步骤序号到它思考卡片下标的映射：思考卡片一旦入列，同一步骤后续的工具卡片
  // 就归到它下面。
  const thinking = new Map<number, number>()
  const children = new Map<number, ChainCard[]>()
  for (const span of spans) {
    const cards = baseCards(span, actions, diffs)
    const first = cards[0]
    if (span.kind === 'step' && first !== undefined) {
      thinking.set(span.seq, top.length)
      top.push(...cards)
      continue
    }
    const step = span.kind === 'tool' ? owner.get(span.seq) : undefined
    if (step === undefined || !thinking.has(step)) {
      top.push(...cards)
      continue
    }
    children.set(step, [...(children.get(step) ?? []), ...cards])
  }
  for (const [step, index] of thinking) {
    const nested = children.get(step)
    const card = top[index]
    if (nested === undefined || card === undefined) continue
    top[index] = { ...card, children: capCards(mergeLevel(nested)) }
  }
  return top
}

/** 构建一个跨度所贡献的卡片；不支撑任何卡片的跨度返回空数组。 */
function baseCards(span: ActivitySpan, actions: ReadonlyMap<number, ChainActions>, diffs: ChangeDiffs): ChainCard[] {
  if (span.kind === 'turn') return turnCards(span)
  if (span.kind === 'step') return stepCards(span, actions.get(span.seq))

  if (span.kind === 'subagent') {
    return [{
      id: `recon:${span.seq}`,
      kind: 'recon',
      title: { copy: 'subagent', name: span.name },
      startedAt: span.startTime,
      status: span.status === 'error' ? 'error' : 'ok',
      evidenceSeqs: [span.seq],
      meta: { tool: 'subagent' },
    }]
  }

  if (span.kind === 'workflow') {
    return [{
      id: `verify:${span.seq}`,
      kind: 'verify',
      title: span.status === 'error'
        ? { copy: 'workflowFailed', name: span.name }
        : { copy: 'workflowCompleted', name: span.name },
      startedAt: span.startTime,
      status: span.status === 'error' ? 'error' : 'ok',
      evidenceSeqs: [span.seq],
    }]
  }

  if (span.kind !== 'tool') return []

  const action = toolAction(span)
  if (action === 'interrupt') return [interruptCard(span)]
  if (action === 'verify') return [verifyCard(span)]
  if (action === 'change') return [changeCard(span, diffs)]
  return [reconCard(span)]
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
    const merged = [...(current.diffs ?? []), ...(card.diffs ?? [])]
    out[existing] = {
      ...current,
      repeat: (current.repeat ?? 1) + 1,
      evidenceSeqs: [...current.evidenceSeqs, ...card.evidenceSeqs],
      ...(merged.length === 0 ? {} : { diffs: merged }),
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

/** 链中记录的人类提示词，作为范围外启发式的任务文本。 */
function recordedTask(spans: readonly ActivitySpan[]): string {
  return spans
    .filter(span => span.kind === 'turn')
    .map(span => attrString(span, 'prompt') ?? '')
    .join('\n')
}

/**
 * 把卡片与它们的行动子卡展开成一列。
 * @param cards - 任意一层的卡片。
 * @returns 深度优先展开的卡片，供汇总与风险规则读取。
 */
function flattenCards(cards: readonly ChainCard[]): ChainCard[] {
  return cards.flatMap(card => card.children === undefined
    ? [card]
    : [card, ...flattenCards(card.children)])
}

/**
 * 把被风险规则标记的变更卡片改成 warning，并保留子卡结构。
 * @param cards - 任意一层的卡片。
 * @param flagged - 被标记的文件路径。
 * @returns 与输入同构的卡片；被标记的变更卡片状态改变。
 */
function markFlagged(cards: readonly ChainCard[], flagged: ReadonlySet<string>): ChainCard[] {
  return cards.map((card) => {
    const children = card.children === undefined ? undefined : markFlagged(card.children, flagged)
    const marked = card.kind === 'change' && card.status === 'ok' && flagged.has(metaPath(card))
      ? { ...card, status: 'warning' as const }
      : card
    return children === undefined ? marked : { ...marked, children }
  })
}

/**
 * 将折叠后的活动跨度投影为评审执行链。
 * @param spans - 采集层的跨度，按序号升序排列。
 * @param userText - 用户的任务文本，仅用于范围外启发式判断；为空时使用链中记录的人类提示词。
 * @param diffs - 每条工具调用记录的差异块，按调用标识索引；省略表示都没有记录。
 * @returns 按展示顺序排列的卡片，以及按严重程度排序的风险标记。
 */
export function chainFromSpans(
  spans: readonly ActivitySpan[],
  userText = '',
  diffs: ChangeDiffs = NO_DIFFS,
): ChainResult {
  const ordered = [...spans].sort((left, right) => left.seq - right.seq)
  const actions = stepActionCounts(ordered)
  const merged = mergeLevel(assembleCards(ordered, actions, diffs))
  const cards = capCards([...merged, resultCard(ordered, flattenCards(merged))])
  const flags = reviewFlags(ordered, flattenCards(cards), userText === '' ? recordedTask(ordered) : userText)
  const flagged = new Set(flags.filter(flag => flag.code !== 'unverified').flatMap(flag => flag.evidenceFiles))
  return { cards: markFlagged(cards, flagged), flags }
}
