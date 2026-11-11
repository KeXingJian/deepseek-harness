/**
 * The review-chain Definition: which events may initialize its Context, and the
 * engine-owned key its view node must carry.
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { conversationContextKey } from '@deepseek-ai/dsh-client-ui-conversation/src/client/contract/conversation.ts'
import type { ChainState } from '../src/client/chain-definition.ts'
import type { ChainSnapshot } from '../src/client/chain-view.ts'
import { chainDefinition } from '../src/client/chain-definition.ts'

/** The key the engine mints for this Definition's single Context. */
const CONTEXT_KEY = conversationContextKey('agent-chain', 'chain')

/** One committed Session event in log order. */
const EVENTS: readonly SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1_000, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: SessionSeq(1),
    time: 1_010,
    surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text: '看一下 src/a.ts' }], source: { kind: 'user' } }),
  },
  { type: 'step/start', seq: SessionSeq(2), time: 1_100, data: { turn: 1, step: 1 } },
  {
    type: 'assistant/message',
    seq: SessionSeq(3),
    time: 1_120,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: '先确认这个文件' }, { type: 'text', text: '看一下实现' }],
        source: { provider: 'test', model: 'test-model' },
      }),
      stream: [],
    },
  },
  {
    type: 'tool/call',
    seq: SessionSeq(4),
    time: 1_150,
    data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'read', arguments: '{"path":"src/a.ts"}' },
  },
  { type: 'step/end', seq: SessionSeq(5), time: 1_200, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: SessionSeq(6), time: 1_300, data: { turn: 1, reason: { kind: 'completed' } } },
]

/** A Session event no chain Definition reads. */
const UNRELATED: SessionEvent = { type: 'session/end-seed', seq: SessionSeq(7), time: 1_400, data: {} }

/** Context as the engine hands one to a Definition before State exists. */
function context(state?: ChainState): ConversationNodeContext<ChainState> {
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
function foldAll(): ChainState {
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
    expect(chain.cards.map(card => card.kind)).toContain('prompt')
    expect(chain.cards.map(card => card.kind)).toContain('thinking')
    expect(chain.cards.map(card => card.kind)).toContain('intent')
    expect(chain.cards.map(card => card.kind)).not.toContain('recon')
    expect(chain.cards.find(card => card.kind === 'thinking')?.children?.map(card => card.kind)).toEqual(['recon'])
    expect(chain.cards.at(-1)?.kind).toBe('result')
    expect(chain.spans).toBe(state.activity.spans)
  })

  it('publishes nothing before the Context has State', () => {
    expect(chainDefinition.buildViewNode?.(context())).toBeNull()
  })
})

/** The private payload of a tool result, as the log carries it. */
type ToolResultMeta = Extract<SessionEvent, { type: 'tool/result' }>['data']['meta']

/** One tool result event carrying an optional private payload. */
function toolResult(seq: number, meta: ToolResultMeta): SessionEvent {
  return {
    type: 'tool/result',
    seq: SessionSeq(seq),
    time: 1_000 + seq,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('call-1'), isError: false, content: [{ type: 'text', text: 'ok' }] }),
      ...(meta === undefined ? {} : { meta }),
    },
  }
}

/** Fold one recorded tool result into a fresh State. */
function recordResult(meta: ToolResultMeta): ChainState {
  return chainDefinition.start(context(), startMatch(toolResult(1, meta)), { previous: () => undefined })
}

/** The diff a file mutation tool records in its result payload. */
const DIFFS = [{ path: 'src/a.ts', oldText: 'a', newText: 'b' }]

describe('recorded diffs', () => {
  it('keeps the applied diffs of a tool result under its call id', () => {
    expect(recordResult({ diffs: DIFFS }).diffs).toEqual({ 'call-1': DIFFS })
  })

  const UNUSABLE: ReadonlyArray<[string, ToolResultMeta]> = [
    ['no payload', undefined],
    ['a null payload', null],
    ['an array payload', []],
    ['no diffs field', { operation: 'update' }],
    ['a non-array diffs field', { diffs: 'nope' }],
    ['an empty diff list', { diffs: [] }],
    ['a non-object hunk', { diffs: [null] }],
    ['a hunk without a path', { diffs: [{ oldText: null, newText: 'b' }] }],
    ['a hunk with a numeric old text', { diffs: [{ path: 'src/a.ts', oldText: 1, newText: 'b' }] }],
    ['a hunk with a numeric new text', { diffs: [{ path: 'src/a.ts', oldText: null, newText: 2 }] }],
  ]

  it.each(UNUSABLE)('records nothing for %s', (_label, meta) => {
    expect(recordResult(meta).diffs).toEqual({})
  })

  it('keeps the State identity when a result records nothing', () => {
    const state = chainDefinition.start(context(), startMatch(EVENTS[0] as SessionEvent), { previous: () => undefined })
    const next = chainDefinition.update({ ...context(state), state }, laterMatch(toolResult(9, undefined)))
    expect(next).toBe(state)
  })

  it('records a payload without diffs as no change to the activity state', () => {
    const call: SessionEvent = {
      type: 'tool/call',
      seq: SessionSeq(1),
      time: 1_100,
      data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'edit', arguments: '{"file_path":"src/a.ts"}' },
    }
    const state = chainDefinition.start(context(), startMatch(call), { previous: () => undefined })
    const next = chainDefinition.update({ ...context(state), state }, laterMatch(toolResult(2, { diffs: DIFFS })))
    expect(next.activity.spans).toHaveLength(1)
    expect(next.diffs).toEqual({ 'call-1': DIFFS })
    const node = chainDefinition.buildViewNode?.({ ...context(next), state: next })
    expect((node?.data as ChainSnapshot).cards[0]?.diffs).toEqual(DIFFS)
  })

  it('folds a result that records no diffs without recording anything', () => {
    const call: SessionEvent = {
      type: 'tool/call',
      seq: SessionSeq(1),
      time: 1_100,
      data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'edit', arguments: '{"file_path":"src/a.ts"}' },
    }
    const state = chainDefinition.start(context(), startMatch(call), { previous: () => undefined })
    const next = chainDefinition.update({ ...context(state), state }, laterMatch(toolResult(2, { operation: 'update' })))
    expect(next.activity.spans[0]?.status).toBe('ok')
    expect(next.diffs).toEqual({})
  })

  it('keeps the State identity for a chain event that folds to nothing', () => {
    const state = chainDefinition.start(context(), startMatch(EVENTS[0] as SessionEvent), { previous: () => undefined })
    const stray: SessionEvent = { type: 'step/end', seq: SessionSeq(9), time: 1_900, data: { turn: 9, step: 9 } }
    expect(chainDefinition.update({ ...context(state), state }, laterMatch(stray))).toBe(state)
  })
})
