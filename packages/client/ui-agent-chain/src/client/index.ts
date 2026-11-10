/**
 * Web 评审链插件：注册链的 Definition、它的视图 target，以及渲染该视图的
 * 会话视图标签页。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { fileAddressFor, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { AgentChainView } from './AgentChainView.tsx'
import { chainDefinition } from './chain-definition.ts'
import { chainViewDefinition, EMPTY_CHAIN } from './chain-view.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import type { AgentChainKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 评审链视图的文案。 */
    'agentChain': AgentChainKey
  }
}

export type { ChainSnapshot } from './chain-view.ts'
export type { AgentChainViewProps } from './AgentChainView.tsx'

/** 必需的服务：slots、会话 target、词典、Session 根目录，以及 Sidebar。 */
export const inject = ['slots', 'uiConversation', 'locale', 'sessions', 'sidebarRight']

/**
 * 客户端插件主体：注册链的 Definition、视图 target，以及该标签页。
 * @param ctx - 客户端根上下文。
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
        // 卡片给出的路径与工具调用记录时一致：相对于 Session 根目录，或者
        // 是该根目录内的绝对路径。Sidebar 预览会用 Host 为此 Session 持有的
        // 根目录来解析该地址。
        openFile: (path: string) => {
          const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
          ctx.sidebarRight.openResource(fileAddressFor(sessionId, cwd, resolveWorkspacePath(cwd, path)))
        },
      }
    },
  }, AgentChainView))
}
