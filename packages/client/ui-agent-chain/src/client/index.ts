/**
 * Web review-chain plugin: registers the chain Definition, its view target, and
 * the conversation view tab that renders it.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { AgentChainView } from './AgentChainView.tsx'
import { chainDefinition } from './chain-definition.ts'
import { chainViewDefinition, EMPTY_CHAIN } from './chain-view.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import type { AgentChainKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Review-chain view copy. */
    'agentChain': AgentChainKey
  }
}

export type { ChainSnapshot } from './chain-view.ts'
export type { AgentChainViewProps } from './AgentChainView.tsx'

/** Required services: the slot registry, conversation targets, and dictionaries. */
export const inject = ['slots', 'uiConversation', 'locale']

/**
 * Client plugin body: register the chain Definition, the view target, and the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-agent-chain: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.uiConversation.events.register(chainDefinition), 'ui-agent-chain: definition')
  ctx.effect(() => ctx.uiConversation.views.register(chainViewDefinition), 'ui-agent-chain: view')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'agent-chain',
    order: 30,
    locale: NS,
    label: () => t('view.chain'),
    inject: (sessionId: SessionId) => {
      const target = ctx.uiConversation.binding(sessionId).target('agent-chain')
      return {
        hooks: {
          chain: {
            getSnapshot: () => target.getSnapshot() ?? EMPTY_CHAIN,
            subscribe: (listener: () => void) => target.subscribe(listener),
          },
        },
      }
    },
  }, AgentChainView))
}
