// @vitest-environment jsdom
/**
 * Review-chain plugin body on the slot-tier runtime: the apply registrations
 * leave with their fiber, and the per-Session inject face publishes the chain
 * target and opens a card's file in the Sidebar preview.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ConversationEventRegistry, ConversationViewRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChainSnapshot } from '../src/client/chain-view.ts'
import { apply, inject } from '../src/client/index.ts'

usePinnedBrowserLanguages('en-US')

const ROOT = 'root-1' as SessionId

/** One change card, its recorded file, and the tool span it cites. */
function chainSnapshot(path: string): ChainSnapshot {
  return {
    cards: [{
      id: 'change:1',
      kind: 'change',
      title: { copy: 'change', op: 'update', path },
      startedAt: 0,
      status: 'ok',
      meta: { path },
      evidenceSeqs: [7],
    }],
    mergedCards: [],
    flags: [],
    spans: [{ seq: 7, kind: 'tool', name: 'bash', startTime: 0, status: 'ok', attributes: { callId: 'call-7' } }],
  }
}

/** Boot the plugin over a declared view slot, one fixture Session, and a chain target. */
async function bench() {
  const runtime = await SlotTestRuntime.create()
  const openResource = vi.fn<(address: string) => void>()
  runtime.ctx.provide('sidebarRight', { openResource })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const chain = createSnapshotStore<ChainSnapshot | undefined>(undefined)
  const target = vi.fn(() => chain)
  const binding = vi.fn(() => ({ target }))
  runtime.ctx.provide('uiConversation', {
    events: new ConversationEventRegistry(runtime.ctx),
    views: new ConversationViewRegistry(runtime.ctx),
    binding,
  } as never)
  await runtime.sessions.add({
    id: ROOT,
    summary: { displayTitle: 'Root', cwd: '/proj' },
    session: {},
  })
  const reference = runtime.sessions.retain(ROOT)
  await reference.ready
  const handle = await runtime.mount({ inject: [...inject], apply })
  await runtime.declare({ 'conversation.view': { kind: 'list', scope: 'session' } })
  const inspectCall = vi.fn<(callId: string) => void>()
  const view = runtime.renderSlot('conversation.view', {
    inspectCall,
    viewRequest: null,
    openView: vi.fn(),
    completeViewRequest: vi.fn(),
  }, { session: reference, only: 'agent-chain' })
  const chainView = () => within(view.container)
  return { runtime, handle, openResource, chain, binding, inspectCall, view, chainView }
}

describe('review chain inject face', () => {
  it('publishes the waiting state and then the target the Conversation bound', async () => {
    const b = await bench()
    expect(b.binding).toHaveBeenCalledWith(ROOT)
    expect(b.chainView().getByText('No activity recorded yet')).toBeTruthy()
    act(() => { b.chain.set(chainSnapshot('src/a.ts')) })
    expect(b.chainView().getByText('src/a.ts modified')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('opens a recorded path at the Session root in the Sidebar preview', async () => {
    const b = await bench()
    act(() => { b.chain.set(chainSnapshot('src/a.ts')) })
    fireEvent.click(b.chainView().getByRole('button', { name: 'Show evidence' }))
    fireEvent.click(b.chainView().getByRole('button', { name: 'Open in preview src/a.ts' }))
    expect(b.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/root-1/src/a.ts')

    // Without a Session row the Host list no longer holds, an absolute path
    // stays absolute in the Session-scoped address instead of being re-rooted.
    await b.runtime.sessions.remove(ROOT)
    act(() => { b.chain.set(chainSnapshot('/proj/src/a.ts')) })
    fireEvent.click(b.chainView().getByRole('button', { name: 'Open in preview /proj/src/a.ts' }))
    expect(b.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/root-1//proj/src/a.ts')
    await b.runtime.dispose()
  })

  it('shows an absolute path relative to the project while opening the recorded one', async () => {
    const b = await bench()
    act(() => { b.chain.set(chainSnapshot('/proj/src/a.ts')) })
    expect(b.chainView().getByText('src/a.ts modified')).toBeTruthy()
    fireEvent.click(b.chainView().getByRole('button', { name: 'Show evidence' }))
    fireEvent.click(b.chainView().getByRole('button', { name: 'Open in preview src/a.ts' }))
    expect(b.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/root-1/src/a.ts')
    await b.runtime.dispose()
  })

  it('opens a cited tool call in the view that inspects calls', async () => {
    const b = await bench()
    act(() => { b.chain.set(chainSnapshot('src/a.ts')) })
    fireEvent.click(b.chainView().getByRole('button', { name: 'Show evidence' }))
    fireEvent.click(b.chainView().getByRole('button', { name: 'Show in Trajectory #7' }))
    expect(b.inspectCall).toHaveBeenCalledWith('call-7')
    await b.runtime.dispose()
  })

  it('removes its view registration when the plugin fiber disposes', async () => {
    const b = await bench()
    expect(b.runtime.slots.entries('conversation.view')).toHaveLength(1)
    await b.handle.dispose()
    expect(b.runtime.slots.entries('conversation.view')).toHaveLength(0)
    await b.runtime.dispose()
  })
})
