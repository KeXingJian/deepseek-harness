/**
 * 评审链的展示词汇：类型标签与配色、状态圆点，以及单张卡片可提供的展开行。
 */

import type { ComponentType } from 'react'
import type {
  ActivitySpan, ChangeOp, ChainActions, ChainCard, ChainKind, ChainStatus, ChainTitle,
} from '@deepseek-ai/dsh-agent-activity'
import type { CommonKey } from '@deepseek-ai/dsh-client-locale/client'
import type { DiffBlockLabels, DiffHunk, IconProps, StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconCheckCircleOutlineRegular, IconChecklistOutlineRegular, IconEditOutlineRegular, IconPlanOutlineRegular,
  IconQuestionOutlineRegular, IconSearchOutlineRegular, IconThinkOutlineRegular, IconUserOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { AgentChainKey } from './locales.ts'

/** 命名一种卡片类型的词典键。 */
export const KIND_KEYS: Readonly<Record<ChainKind, AgentChainKey>> = {
  prompt: 'kind.prompt',
  thinking: 'kind.thinking',
  intent: 'kind.intent',
  recon: 'kind.recon',
  change: 'kind.change',
  verify: 'kind.verify',
  interrupt: 'kind.interrupt',
  result: 'kind.result',
}

/** 一种卡片类型的字形；读者按图形分辨卡片类别，颜色留给状态与风险。 */
export const KIND_GLYPHS: Readonly<Record<ChainKind, ComponentType<IconProps>>> = {
  prompt: IconUserOutlineRegular,
  thinking: IconThinkOutlineRegular,
  intent: IconPlanOutlineRegular,
  recon: IconSearchOutlineRegular,
  change: IconEditOutlineRegular,
  verify: IconChecklistOutlineRegular,
  interrupt: IconQuestionOutlineRegular,
  result: IconCheckCircleOutlineRegular,
}

/** 命名投影记录的一种变更操作的词典键。 */
const OP_KEYS: Readonly<Record<string, AgentChainKey>> = {
  create: 'op.create',
  update: 'op.update',
  delete: 'op.delete',
}

/** 命名一种变更说明来源的词典键；没有记录来源时按未点名的本步上下文显示。 */
const NOTE_KEYS: Readonly<Record<string, AgentChainKey>> = {
  file: 'meta.noteChanged',
  step: 'meta.noteStep',
  intent: 'meta.noteTurn',
}

/** 卡片展开时显示的一条带标签的事实。 */
export interface ChainDetailRow {
  /** 本地化的字段名。 */
  readonly label: string
  /** 记录时的字段值；从不翻译。 */
  readonly value: string
  /** 该值所指的工作区路径，仅当文件预览能打开它时存在。 */
  readonly file?: string | undefined
}

/** 展开卡片下方显示的一个贡献 span。 */
export interface ChainEvidenceSpan {
  /** 读者可在转录中核对的 Session 日志位置。 */
  readonly seq: number
  /** 原始 span 名称，从不翻译。 */
  readonly name: string
  /** span 结算结果对应的圆点状态。 */
  readonly dot: StateDotState
  /** 当该 span 是一次调用时，为工具调用的标识；turn 和 step 类型的 span 没有该字段。 */
  readonly callId?: string | undefined
}

/** 翻译一个评审链键或共享通用词条，并插值消息中声明的占位符。 */
export type ChainTranslate = (key: AgentChainKey | CommonKey, params?: Record<string, unknown>) => string

/**
 * 把记录时的工作区路径改写为读者看到的文本。
 *
 * 记录值是工具拿到的原样路径，可能带整条工作区根目录；展示层只显示相对于项目
 * 根的路径，工作区根目录未知时原样返回。打开文件仍用记录值，因此这个改写只影响
 * 文本。
 */
export type ChainPathLabel = (path: string) => string

/**
 * 组合一张卡片记录的差异块，供 `DiffBlock` 渲染。
 * @param card - 链上的卡片。
 * @param label - 把差异块的文件路径改写为展示文本。
 * @returns 差异块；卡片没有记录差异时为空数组。
 */
export function cardDiffs(card: ChainCard, label: ChainPathLabel): DiffHunk[] {
  return card.diffs === undefined ? [] : card.diffs.map(diff => ({ ...diff, path: label(diff.path) }))
}

/**
 * 组合差异卡片的界面文案。
 *
 * 复制、换行与折叠用共享通用词汇，只有差异行数相关的三条走本命名空间词典。
 * @param t - 评审链翻译器。
 * @returns 代码工具栏、复制与折叠文案。
 */
export function diffLabels(t: ChainTranslate): DiffBlockLabels {
  return {
    codeLabel: t('codeBlock.title'),
    wrapLabel: t('codeBlock.wrap'),
    unwrapLabel: t('codeBlock.unwrap'),
    copy: t('copy'),
    copied: t('copied'),
    collapseAria: t('diff.collapseAria'),
    expandAria: count => t('diff.expandAria', { count }),
    collapse: t('collapse'),
    expand: count => t('diff.expandRest', { count }),
  }
}

/** 命名一种文件操作卡片标题的词典键。 */
const CHANGE_TITLE_KEYS: Readonly<Record<ChangeOp, AgentChainKey>> = {
  create: 'title.changeCreate',
  update: 'title.changeUpdate',
  delete: 'title.changeDelete',
}

/**
 * 组合一张勘察卡片的计数标题。
 * @param files - 合并后的卡片打开的文件数。
 * @param searches - 合并后的卡片执行的检索数。
 * @param t - 评审链翻译器。
 * @returns 由取值为正的那些总数构成的标题。
 */
function reconText(files: number, searches: number, t: ChainTranslate): string {
  if (files > 0 && searches > 0) return t('title.recon', { files, searches })
  if (files > 0) return t('title.reconFiles', { files })
  if (searches > 0) return t('title.reconSearches', { searches })
  return t('title.reconNone')
}

/**
 * 用读者的语言组合单张卡片的标题。
 * @param card - 要渲染的卡片。
 * @param t - 评审链翻译器。
 * @param label - 把卡片里的文件路径改写为展示文本。
 * @returns 标题文本；prompt、thinking 与 intent 卡片会原样返回记录下来的措辞。
 */
export function cardTitle(card: ChainCard, t: ChainTranslate, label: ChainPathLabel): string {
  return titleText(card.title, t, label)
}

/**
 * 用读者的语言组合一张思考卡片的行动摘要。
 * @param actions - 投影记录的该步骤行动计数。
 * @param t - 评审链翻译器。
 * @returns 只包含正数计数的一行摘要，各部分以中点分隔。
 */
export function actionSummary(actions: ChainActions, t: ChainTranslate): string {
  const parts: string[] = []
  if (actions.files > 0) parts.push(t('actions.files', { count: actions.files }))
  if (actions.searches > 0) parts.push(t('actions.searches', { count: actions.searches }))
  if (actions.changes > 0) parts.push(t('actions.changes', { count: actions.changes }))
  if (actions.verifications > 0) parts.push(t('actions.verifications', { count: actions.verifications }))
  return parts.join(' · ')
}

/** 组合一条消息描述符的标题。 */
function titleText(title: ChainTitle, t: ChainTranslate, label: ChainPathLabel): string {
  switch (title.copy) {
    case 'prompt':
    case 'thinking':
    case 'intent':
      return title.text
    case 'recon':
      return reconText(title.files, title.searches, t)
    case 'reconCollapsed':
      return t('title.reconCollapsed')
    case 'subagent':
      return t('title.subagent', { name: title.name })
    case 'workflowCompleted':
      return t('title.workflowCompleted', { name: title.name })
    case 'workflowFailed':
      return t('title.workflowFailed', { name: title.name })
    case 'interrupt':
      return t('title.interrupt', { seconds: title.seconds })
    case 'change':
      return t(CHANGE_TITLE_KEYS[title.op], { path: label(title.path) })
    case 'verifyPassed':
      return t('title.verifyPassed', { command: title.command })
    case 'verifyFailed':
      return title.errorCode === undefined
        ? t('title.verifyFailed', { command: title.command })
        : t('title.verifyFailedCode', { command: title.command, code: title.errorCode })
    case 'verifyRun':
      return t('title.verifyRun', { count: title.count })
    case 'result':
      return t('title.result', { files: title.files, verifications: title.verifications })
  }
  /* v8 ignore next -- 封闭联合的兜底分支；上面已处理所有标题变体。 */
  return assertNever(title, 'chain title')
}

/**
 * 把卡片状态映射到共享的状态圆点。
 * @param state - 投影得到的卡片状态。
 * @returns 圆点状态；`ok` 显示为完成，`running` 显示为进行中的加载指示。
 */
export function statusDot(state: ChainStatus | undefined): StateDotState {
  switch (state) {
    case 'error':
      return 'error'
    case 'warning':
      return 'warning'
    case 'running':
      return 'ongoing'
    default:
      return 'done'
  }
}

/**
 * 隐藏或显示勘察卡片，勘察是背景工作，评审者常整段跳过。
 *
 * 隐藏时把每条顶层勘察卡片连同它折叠出的内容一起删除；思考卡片下的勘察
 * 子卡跟着父卡一起保留或移除。筛选器随后再收窄结果。
 * @param cards - 按展示顺序排列的顶层卡片。
 * @param hidden - 是否隐藏勘察卡片。
 * @returns 隐藏时过滤后的卡片；显示时保持输入数组不变。
 */
export function hideReconCards(cards: readonly ChainCard[], hidden: boolean): readonly ChainCard[] {
  if (!hidden) return cards
  return cards.flatMap((card) => {
    const children = card.children === undefined ? undefined : hideReconCards(card.children, hidden)
    if (card.kind === 'recon') return []
    return [children === undefined ? card : { ...card, children }]
  })
}

/**
 * 把 span 的结算结果映射到共享的状态圆点。
 * @param status - span 上记录的结算结果。
 * @returns 圆点状态；在结算前就停止的 span 显示为警告。
 */
export function spanDot(status: ActivitySpan['status']): StateDotState {
  switch (status) {
    case 'running':
      return 'ongoing'
    case 'ok':
      return 'done'
    case 'error':
      return 'error'
    default:
      return 'warning'
  }
}

/**
 * 把一条记录的事实按字符串读取。
 * @param meta - 卡片事实。
 * @param key - 事实名称。
 * @returns 该值；缺失或不是字符串时为 undefined。
 */
function metaString(meta: ChainCard['meta'], key: string): string | undefined {
  const value = meta?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * 把一条记录的事实按正数计数读取。
 * @param meta - 卡片事实。
 * @param key - 事实名称。
 * @returns 计数的文本形式；缺失、不是数字或不为正数时为 undefined。
 */
function metaCount(meta: ChainCard['meta'], key: string): string | undefined {
  const value = meta?.[key]
  return typeof value === 'number' && value > 0 ? String(value) : undefined
}

/**
 * 构建一张展开的卡片所显示的带标签事实。
 *
 * `prompt`、`thinking`、`path`、`command` 和 `tool` 对某些类型来说重复了标题中
 * 已有的内容，但读者展开卡片是在核对记录，而不是快速浏览。
 * @param card - 正在展开的卡片。
 * @param t - 评审链翻译器。
 * @param label - 把卡片里的文件路径改写为展示文本。
 * @returns 按固定字段顺序排列的行；卡片没有记录任何内容时为空。
 */
export function detailRows(card: ChainCard, t: ChainTranslate, label: ChainPathLabel): readonly ChainDetailRow[] {
  const rows: ChainDetailRow[] = []
  const prompt = metaString(card.meta, 'prompt')
  if (prompt !== undefined) rows.push({ label: t('meta.prompt'), value: prompt })
  const thinking = metaString(card.meta, 'thinking')
  if (thinking !== undefined) rows.push({ label: t('meta.thinking'), value: thinking })
  const path = metaString(card.meta, 'path')
  if (path !== undefined) rows.push({ label: t('meta.path'), value: label(path), file: path })
  const note = metaString(card.meta, 'note')
  // 来源缺失时按本步上下文标注：一条说明点没点名该文件由投影决定，展示层不重复推断。
  const noteKey = NOTE_KEYS[metaString(card.meta, 'noteFrom') ?? ''] ?? 'meta.noteStep'
  if (note !== undefined) rows.push({ label: t(noteKey), value: note })
  const command = metaString(card.meta, 'command')
  if (command !== undefined) rows.push({ label: t('meta.command'), value: command })
  const tool = metaString(card.meta, 'tool')
  if (tool !== undefined) rows.push({ label: t('meta.tool'), value: tool })
  const op = metaString(card.meta, 'op')
  if (op !== undefined) {
    const key = OP_KEYS[op]
    rows.push({ label: t('meta.op'), value: key === undefined ? op : t(key) })
  }
  const files = metaCount(card.meta, 'files')
  if (files !== undefined) rows.push({ label: t('meta.files'), value: files })
  const searches = metaCount(card.meta, 'searches')
  if (searches !== undefined) rows.push({ label: t('meta.searches'), value: searches })
  return rows
}

/**
 * 按卡片依据列出的顺序读取它引用的 span。
 * @param card - 展开的卡片。
 * @param spans - 链快照发布的所有 span。
 * @returns 快照仍持有的每个被引用序号对应一行。
 */
export function evidenceSpans(card: ChainCard, spans: readonly ActivitySpan[]): readonly ChainEvidenceSpan[] {
  const bySeq = new Map(spans.map(span => [span.seq, span]))
  return card.evidenceSeqs.flatMap((seq) => {
    const span = bySeq.get(seq)
    if (span === undefined) return []
    const callId = span.attributes?.callId
    return [{
      seq,
      name: span.name,
      dot: spanDot(span.status),
      callId: typeof callId === 'string' ? callId : undefined,
    }]
  })
}

/**
 * 判断卡片是否有可展示的内容。
 * @param card - 列表中的卡片。
 * @param rows - 它的展开事实。
 * @returns 展开后会显示事实、差异或依据时为 true。
 */
export function isExpandable(card: ChainCard, rows: readonly ChainDetailRow[]): boolean {
  return rows.length > 0 || card.evidenceSeqs.length > 0 || (card.diffs?.length ?? 0) > 0
}
