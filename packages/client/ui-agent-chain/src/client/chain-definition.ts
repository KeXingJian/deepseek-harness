/**
 * 会话 Definition：把持久化的 Session 事件折叠成链快照。
 */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { applyActivityEvent, chainFromSpans, initActivityState } from '@deepseek-ai/dsh-agent-activity'
import type { ActivityState, ChainDiff } from '@deepseek-ai/dsh-agent-activity'

/** 链会读取的事件类型；其他事件都不会改动状态。 */
const CHAIN_EVENTS = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
])

/** 按工具调用标识索引的应用后差异块。 */
type RecordedDiffs = Readonly<Record<string, readonly ChainDiff[]>>

/** 一个会话的折叠状态：跨度，加上工具结果记录的差异块。 */
export interface ChainState {
  /** 由会话事件折叠出的活动跨度。 */
  readonly activity: ActivityState
  /** 工具结果记录的应用后差异；键是工具调用标识。 */
  readonly diffs: RecordedDiffs
}

/**
 * 读取一次工具结果记录的应用后差异。
 *
 * `meta` 是工具私有的 JSON 负载，跨持久化边界，因此只接受形状完整的条目；
 * 形状不符或没有差异时视为没有记录，而不是推断。
 * @param meta - `tool/result` 的可选私有负载。
 * @returns 记录的应用后差异，或 undefined。
 */
function recordedDiffs(meta: unknown): readonly ChainDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const hunks = (meta as Record<string, unknown>)['diffs']
  if (!Array.isArray(hunks)) return undefined
  const out: ChainDiff[] = []
  for (const hunk of hunks) {
    if (typeof hunk !== 'object' || hunk === null) return undefined
    const { path, oldText, newText } = hunk as Record<string, unknown>
    if (typeof path !== 'string') return undefined
    if (oldText !== null && typeof oldText !== 'string') return undefined
    if (typeof newText !== 'string') return undefined
    out.push({ path, oldText, newText })
  }
  return out.length === 0 ? undefined : out
}

/**
 * 把一个链事件应用到折叠状态。
 * @param state - 当前状态；永不被修改。
 * @param event - 按日志顺序排列的事件。
 * @returns 下一个状态。
 */
function applyChainEvent(state: ChainState, event: SessionEvent): ChainState {
  const activity = applyActivityEvent(state.activity, event)
  if (event.type !== 'tool/result') return activity === state.activity ? state : { ...state, activity }
  const recorded = recordedDiffs(event.data.meta)
  if (recorded === undefined) return activity === state.activity ? state : { ...state, activity }
  // 差异属于这次调用而不是结果文本，因此按调用标识归档，供链投影挂到改动卡片上。
  return { activity, diffs: { ...state.diffs, [String(event.data.message.toolCallId)]: recorded } }
}

/** 折叠开始前的空状态。 */
const INITIAL: ChainState = { activity: initActivityState(), diffs: {} }

/** 每个 Session 一条评审链，由其已提交的事件折叠而成。 */
export const chainDefinition: ConversationNodeDefinition<ChainState> = {
  kind: 'agent-chain',
  target: 'agent-chain',
  // 任何链事件都可能成为历史窗口中保留的最早事件，因此每个事件都是 start 候选：
  // 最早的那个初始化 Context，后续的更新它。只匹配 update 会让 Context 无法启动，
  // 因为引擎只凭 start 的 Match 创建 State。
  match: event => (CHAIN_EVENTS.has(event.type) ? { id: 'chain', role: 'start' } : null),
  start: (_context, match) => applyChainEvent(INITIAL, match.event as SessionEvent),
  update: (context, match) => applyChainEvent(context.state, match.event as SessionEvent),
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const spans = state.activity.spans
    const chain = chainFromSpans(spans, '', state.diffs, { merge: false })
    const merged = chainFromSpans(spans, '', state.diffs)
    return {
      // Context 的身份由引擎掌握；手写的 key 无法通过校验。
      key: context.key,
      kind: 'agent-chain',
      id: context.id,
      target: 'agent-chain',
      // 仅凭结果无法展示卡片背后的内容：展开时会按序号读取原始 span，
      // 因此快照会携带折叠出它的那些 span。
      data: { ...chain, mergedCards: merged.cards, spans },
    }
  },
}
