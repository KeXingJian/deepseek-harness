/**
 * Conversation Definition folding durable Session events into the chain snapshot.
 */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { applyActivityEvent, chainFromSpans, initActivityState } from '@deepseek-ai/dsh-agent-activity'
import type { ActivityState } from '@deepseek-ai/dsh-agent-activity'

/** Event types the chain reads; every other event leaves the state untouched. */
const CHAIN_EVENTS = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'assistant/message',
  'tool/call',
  'tool/result',
])

/** One review chain per Session, folded from its committed events. */
export const chainDefinition: ConversationNodeDefinition<ActivityState> = {
  kind: 'agent-chain',
  target: 'agent-chain',
  // Every chain event can be the earliest one retained in a history window, so
  // each is a start candidate: the earliest initializes the Context and later
  // ones update it. An update-only match would leave the Context unstarted,
  // because the engine creates State from a start Match alone.
  match: event => (CHAIN_EVENTS.has(event.type) ? { id: 'chain', role: 'start' } : null),
  start: (_context, match) => applyActivityEvent(initActivityState(), match.event as SessionEvent),
  update: (context, match) => applyActivityEvent(context.state, match.event as SessionEvent),
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    return {
      // The engine owns the Context identity; a hand-written key fails validation.
      key: context.key,
      kind: 'agent-chain',
      id: context.id,
      target: 'agent-chain',
      // The result alone cannot show what backs a card: expansion reads the raw
      // span by sequence, so the snapshot carries the spans it was folded from.
      data: { ...chainFromSpans(state.spans), spans: state.spans },
    }
  },
}
