// @vitest-environment jsdom
/**
 * The review-chain plugin inside the assembled Web client: its source `apply`
 * offers a `conversation.view` tab beside Chat and Trajectory, labelled from its
 * own dictionary.
 */
import { expect } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import * as chainPlugin from '../src/client/index.ts'

/** Roster row this spec boots from source rather than from its built bundle. */
const PACKAGE = '@deepseek-ai/dsh-client-ui-agent-chain'

const it = createClientTest({ roster: webApp, provide: { [PACKAGE]: chainPlugin } })

it('offers the review chain as a conversation view tab', async ({ start }) => {
  const client = await start()
  const entry = client.ctx.slots.entries('conversation.view')
    .find(candidate => candidate.options.id === 'agent-chain')
  if (entry === undefined) throw new Error('review chain view tab is not registered')
  expect(entry.locale).toBe('agentChain')
  expect(['Chain', '执行链']).toContain(resolveSlotLabel(entry.options.label))
}, 60_000)
