/**
 * 会话 Definition：把持久化的 Session 事件折叠成链快照。
 */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { applyActivityEvent, chainFromSpans, initActivityState } from '@deepseek-ai/dsh-agent-activity'
import type { ActivityState } from '@deepseek-ai/dsh-agent-activity'

/** 链会读取的事件类型；其他事件都不会改动状态。 */
const CHAIN_EVENTS = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'assistant/message',
  'tool/call',
  'tool/result',
])

/** 每个 Session 一条评审链，由其已提交的事件折叠而成。 */
export const chainDefinition: ConversationNodeDefinition<ActivityState> = {
  kind: 'agent-chain',
  target: 'agent-chain',
  // 任何链事件都可能成为历史窗口中保留的最早事件，因此每个事件都是 start 候选：
  // 最早的那个初始化 Context，后续的更新它。只匹配 update 会让 Context 无法启动，
  // 因为引擎只凭 start 的 Match 创建 State。
  match: event => (CHAIN_EVENTS.has(event.type) ? { id: 'chain', role: 'start' } : null),
  start: (_context, match) => applyActivityEvent(initActivityState(), match.event as SessionEvent),
  update: (context, match) => applyActivityEvent(context.state, match.event as SessionEvent),
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    return {
      // Context 的身份由引擎掌握；手写的 key 无法通过校验。
      key: context.key,
      kind: 'agent-chain',
      id: context.id,
      target: 'agent-chain',
      // 仅凭结果无法展示卡片背后的内容：展开时会按序号读取原始 span，
      // 因此快照会携带折叠出它的那些 span。
      data: { ...chainFromSpans(state.spans), spans: state.spans },
    }
  },
}
