/**
 * The review-chain Definition: which events may initialize its Context, and the
 * engine-owned key its view node must carry.
 */
import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { conversationContextKey } from '@deepseek-ai/dsh-client-ui-conversation/src/client/contract/conversation.ts'
import type { ActivityState } from '@deepseek-ai/dsh-agent-activity'
import type { ChainSnapshot } from '../src/client/chain-view.ts'
import { chainDefinition } from '../src/client/chain-definition.ts'

/** The key the engine mints for this Definition's single Context. */
const CONTEXT_KEY = conversationContextKey('agent-chain', 'chain')

/** One committed Session event in log order. */
const EVENTS: readonly SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1_000, data: { turn: 1 } },
  { type: 'step/start', seq: SessionSeq(1), time: 1_000, data: { turn: 1, step: 1 } },
  {
    type: 'tool/call',
    seq: SessionSeq(2),
    time: 1_100,
    data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'read', arguments: '{"path":"src/a.ts"}' },
  },
  { type: 'step/end', seq: SessionSeq(3), time: 1_200, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: SessionSeq(4), time: 1_300, data: { turn: 1, reason: { kind: 'completed' } } },
]

/** A Session event no chain Definition reads. */
const UNRELATED: SessionEvent = { type: 'session/end-seed', seq: SessionSeq(5), time: 1_400, data: {} }

/** Context as the engine hands one to a Definition before State exists. */
function context(state?: ActivityState): ConversationNodeContext<ActivityState> {
  return {
    key: CONTEXT_KEY,
    kind: 'agent-chain',
    id: 'chain',
    matches: [],
    start: undefined,
    state,
    current: new Map(),
  }
}

/** Match the engine builds for a start-role hit. */
function startMatch(event: SessionEvent): ConversationStartMatch {
  return { event, role: 'start', location: { kind: 'session' } }
}

/** Match the engine builds for a later hit in the same Context. */
function laterMatch(event: SessionEvent): ConversationMatch {
  return { event, role: 'update', location: { kind: 'session' } }
}

/** Fold every event after the first into the started State. */
function foldAll(): ActivityState {
  const first = EVENTS[0]
  if (first === undefined) throw new Error('the fixture needs a first event')
  let state = chainDefinition.start(context(), startMatch(first), { previous: () => undefined })
  for (const event of EVENTS.slice(1)) state = chainDefinition.update({ ...context(state), state }, laterMatch(event))
  return state
}

describe('chain Definition matching', () => {
  it('offers every chain event as a start candidate', () => {
    for (const event of EVENTS) expect(chainDefinition.match(event)).toEqual({ id: 'chain', role: 'start' })
  })

  it('ignores events the chain does not read', () => {
    expect(chainDefinition.match(UNRELATED)).toBeNull()
  })
})

describe('chain Definition view node', () => {
  it('publishes the engine-owned Context key and target', () => {
    const state = foldAll()
    const node = chainDefinition.buildViewNode?.({ ...context(state), state })
    expect(node?.key).toBe(CONTEXT_KEY)
    expect(node?.target).toBe('agent-chain')
  })

  it('publishes the folded chain and its spans as the node data', () => {
    const state = foldAll()
    const node = chainDefinition.buildViewNode?.({ ...context(state), state })
    const chain = node?.data as ChainSnapshot
    expect(chain.cards.map(card => card.kind)).toContain('recon')
    expect(chain.cards.at(-1)?.kind).toBe('result')
    expect(chain.spans).toBe(state.spans)
  })

  it('publishes nothing before the Context has State', () => {
    expect(chainDefinition.buildViewNode?.(context())).toBeNull()
  })
})
