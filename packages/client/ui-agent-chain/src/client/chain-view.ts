/**
 * Review-chain conversation view: one target whose snapshot is the whole chain.
 */

import type {
  ConversationViewBuilder, ConversationViewDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ActivitySpan, ChainCard, RiskFlag } from '@deepseek-ai/dsh-agent-activity'

/** What the view renders: the projected chain for one Session. */
export interface ChainSnapshot {
  /** Cards in display order. */
  readonly cards: readonly ChainCard[]
  /** Review risk flags ordered by severity. */
  readonly flags: readonly RiskFlag[]
  /** Every span the cards cite, in log order; expansion reads them by sequence. */
  readonly spans: readonly ActivitySpan[]
}

/** Snapshot before the Session publishes any chain node. */
export const EMPTY_CHAIN: ChainSnapshot = { cards: [], flags: [], spans: [] }

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Review chain snapshot published by the agent-chain target. */
    'agent-chain': ChainSnapshot
  }
}

/** Builder collecting the single chain node this target publishes. */
class ChainSnapshotBuilder implements ConversationViewBuilder<ConversationViewNode, ChainSnapshot> {
  readonly empty = EMPTY_CHAIN
  private readonly nodes = new Map<string, ConversationViewNode>()

  replace(input: { readonly nodes: readonly ConversationViewNode[] }): ChainSnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  apply(input: { readonly upserts: readonly ConversationViewNode[] }): ChainSnapshot {
    for (const node of input.upserts) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  private snapshot(): ChainSnapshot {
    const node = [...this.nodes.values()][0]
    return node === undefined ? EMPTY_CHAIN : node.data as ChainSnapshot
  }
}

/** Conversation view definition for the review chain. */
export const chainViewDefinition: ConversationViewDefinition<ConversationViewNode, ChainSnapshot> = {
  target: 'agent-chain',
  create: () => new ChainSnapshotBuilder(),
}
