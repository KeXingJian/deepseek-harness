/**
 * 评审链会话视图：只有一个 target，其快照就是整条链。
 */

import type {
  ConversationViewBuilder, ConversationViewDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ActivitySpan, ChainCard, RiskFlag } from '@deepseek-ai/dsh-agent-activity'

/** 视图渲染的内容：某个 Session 投影出的链。 */
export interface ChainSnapshot {
  /** 按事件时间排列、未做语义合并的卡片。 */
  readonly cards: readonly ChainCard[]
  /** 按事件时间排列并合并重复工作的卡片。 */
  readonly mergedCards: readonly ChainCard[]
  /** 按严重程度排序的评审风险标记。 */
  readonly flags: readonly RiskFlag[]
  /** 卡片引用的所有 span，按日志顺序排列；展开时按序号读取它们。 */
  readonly spans: readonly ActivitySpan[]
}

/** Session 尚未发布任何链节点时的快照。 */
export const EMPTY_CHAIN: ChainSnapshot = { cards: [], mergedCards: [], flags: [], spans: [] }

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** 由 agent-chain target 发布的评审链快照。 */
    'agent-chain': ChainSnapshot
  }
}

/** 收集该 target 发布的唯一链节点的构建器。 */
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

/** 评审链的会话视图定义。 */
export const chainViewDefinition: ConversationViewDefinition<ConversationViewNode, ChainSnapshot> = {
  target: 'agent-chain',
  create: () => new ChainSnapshotBuilder(),
}
