/**
 * 评审链的展示词汇：筛选选择、类型标签与配色、状态圆点，以及单张卡片
 * 可提供的展开行。
 */

import type {
  ActivitySpan, ChangeOp, ChainCard, ChainKind, ChainStatus, ChainTitle, RiskFlag, RiskReason, RiskSeverity,
} from '@deepseek-ai/dsh-agent-activity'
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { AgentChainKey } from './locales.ts'

/** 读者要求查看哪些卡片。 */
export type ChainFilter = 'all' | 'changes' | 'risks'

/** 按展示顺序排列的筛选按钮。 */
export const CHAIN_FILTERS: readonly ChainFilter[] = ['all', 'changes', 'risks']

/** 命名一个筛选器的词典键。 */
export const FILTER_KEYS: Readonly<Record<ChainFilter, AgentChainKey>> = {
  all: 'filter.all',
  changes: 'filter.changes',
  risks: 'filter.risks',
}

/** 命名一种卡片类型的词典键。 */
export const KIND_KEYS: Readonly<Record<ChainKind, AgentChainKey>> = {
  intent: 'kind.intent',
  recon: 'kind.recon',
  change: 'kind.change',
  verify: 'kind.verify',
  interrupt: 'kind.interrupt',
  result: 'kind.result',
}

/** 一种卡片类型的标签配色；失败和警告仍由状态圆点表示。 */
export const KIND_TONES: Readonly<Record<ChainKind, TagTone>> = {
  intent: 'info',
  recon: 'quiet',
  change: 'neutral',
  verify: 'outline',
  interrupt: 'warning',
  result: 'outline',
}

/** 一种风险严重程度的标签配色。 */
export const SEVERITY_TONES: Readonly<Record<RiskSeverity, TagTone>> = {
  danger: 'danger',
  warn: 'warning',
  info: 'info',
}

/** 命名一种风险严重程度的词典键。 */
export const SEVERITY_KEYS: Readonly<Record<RiskSeverity, AgentChainKey>> = {
  danger: 'severity.danger',
  warn: 'severity.warn',
  info: 'severity.info',
}

/** 命名投影记录的一种变更操作的词典键。 */
const OP_KEYS: Readonly<Record<string, AgentChainKey>> = {
  create: 'op.create',
  update: 'op.update',
  delete: 'op.delete',
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

/** 翻译一个评审链键，并插值消息中声明的占位符。 */
export type ChainTranslate = (key: AgentChainKey, params?: Record<string, unknown>) => string

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
 * @returns 标题文本；intent 卡片会原样返回模型自己的措辞。
 */
export function cardTitle(card: ChainCard, t: ChainTranslate): string {
  return titleText(card.title, t)
}

/** 组合一条消息描述符的标题。 */
function titleText(title: ChainTitle, t: ChainTranslate): string {
  switch (title.copy) {
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
      return t(CHANGE_TITLE_KEYS[title.op], { path: title.path })
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
 * 用读者的语言组合一个风险标记的原因。
 * @param flag - 要渲染的标记。
 * @param t - 评审链翻译器。
 * @returns 原因文本。
 */
export function riskReason(flag: RiskFlag, t: ChainTranslate): string {
  return reasonText(flag.reason, t)
}

/** 组合一条规则发现的原因。 */
function reasonText(reason: RiskReason, t: ChainTranslate): string {
  switch (reason.copy) {
    case 'touchesTests':
      return t('risk.touchesTests')
    case 'touchesCi':
      return t('risk.touchesCi')
    case 'deletes':
      return t('risk.deletes', { count: reason.count })
    case 'outOfScope':
      return t('risk.outOfScope')
    case 'unverified':
      return t('risk.unverified')
    case 'gaveUp':
      return t('risk.gaveUp')
    case 'planChurn':
      return t('risk.planChurn', { count: reason.count })
  }
  /* v8 ignore next -- 封闭联合的兜底分支；上面已处理所有规则发现。 */
  return assertNever(reason, 'risk reason')
}

/**
 * 把卡片状态映射到共享的状态圆点。
 * @param status - 投影得到的卡片状态。
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
 * 保留某个筛选器允许的卡片。
 * @param cards - 按展示顺序排列的链卡片。
 * @param filter - 选中的筛选器。
 * @returns 匹配的卡片；`all` 会保持输入数组不变。
 */
export function filterCards(cards: readonly ChainCard[], filter: ChainFilter): readonly ChainCard[] {
  switch (filter) {
    case 'changes':
      return cards.filter(card => card.kind === 'change')
    case 'risks':
      return cards.filter(card => card.status === 'error' || card.status === 'warning')
    default:
      return cards
  }
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
 * `path`、`command` 和 `tool` 对某些类型来说重复了标题中已有的内容，但读者展开
 * 卡片是在核对记录，而不是快速浏览。
 * @param card - 正在展开的卡片。
 * @param t - 评审链翻译器。
 * @returns 按固定字段顺序排列的行；卡片没有记录任何内容时为空。
 */
export function detailRows(card: ChainCard, t: ChainTranslate): readonly ChainDetailRow[] {
  const rows: ChainDetailRow[] = []
  const path = metaString(card.meta, 'path')
  if (path !== undefined) rows.push({ label: t('meta.path'), value: path, file: path })
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
 * @returns 展开后会显示事实或依据时为 true。
 */
export function isExpandable(card: ChainCard, rows: readonly ChainDetailRow[]): boolean {
  return rows.length > 0 || card.evidenceSeqs.length > 0
}
