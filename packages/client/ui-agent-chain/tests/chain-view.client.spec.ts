/**
 * Review-chain view target: the per-Session builder that turns published nodes
 * into the snapshot the view renders.
 */
import { describe, expect, it } from 'vitest'
import type { ConversationTimelineSnapshot, ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChainSnapshot } from '../src/client/chain-view.ts'
import { chainViewDefinition, EMPTY_CHAIN } from '../src/client/chain-view.ts'

/** Timeline facts the builder accepts but the chain ignores. */
const TIMELINE: ConversationTimelineSnapshot = { turnOrder: [], turns: new Map() }

/** A chain snapshot as the Definition publishes it. */
const CHAIN: ChainSnapshot = {
  cards: [{
    id: 'intent:1',
    kind: 'intent',
    title: { copy: 'intent', text: 'inspect the catalog module' },
    startedAt: 1_000,
    status: 'ok',
    evidenceSeqs: [1],
  }],
  flags: [{
    code: 'touches-tests',
    severity: 'danger',
    reason: { copy: 'touchesTests' },
    evidenceFiles: ['tests/a.spec.ts'],
  }],
  spans: [{ seq: 1, kind: 'turn', name: 'turn:1', startTime: 1_000, status: 'ok' }],
}

/** One published view node carrying a chain snapshot. */
function node(data: unknown, key = 'k'): ConversationViewNode {
  return { key, kind: 'agent-chain', id: 'chain', target: 'agent-chain', data }
}

describe('chain view target', () => {
  it('registers the agent-chain target with an empty snapshot', () => {
    expect(chainViewDefinition.target).toBe('agent-chain')
    expect(chainViewDefinition.create().empty).toBe(EMPTY_CHAIN)
  })

  it('publishes the node data as its snapshot', () => {
    const builder = chainViewDefinition.create()
    expect(builder.replace({ nodes: [node(CHAIN)], timeline: TIMELINE })).toBe(CHAIN)
    expect(builder.apply({ upserts: [node(CHAIN)], timeline: TIMELINE })).toBe(CHAIN)
  })

  it('replaces the published node when the engine republishes its key', () => {
    const builder = chainViewDefinition.create()
    builder.apply({ upserts: [node(CHAIN, 'stable-key')], timeline: TIMELINE })
    const next: ChainSnapshot = { cards: [], flags: [], spans: [] }
    expect(builder.apply({ upserts: [node(next, 'stable-key')], timeline: TIMELINE })).toBe(next)
  })

  it('drops every node when the complete set is empty', () => {
    const builder = chainViewDefinition.create()
    builder.apply({ upserts: [node(CHAIN)], timeline: TIMELINE })
    expect(builder.replace({ nodes: [], timeline: TIMELINE })).toBe(EMPTY_CHAIN)
  })
})
