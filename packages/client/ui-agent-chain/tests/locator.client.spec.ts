// @vitest-environment jsdom
/**
 * Review-chain locator and streaming helpers: bar mapping, jump behavior,
 * scroll targeting, the scroll-spy over rendered cards, and paged rendering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ChainCard } from '@deepseek-ai/dsh-agent-activity'
import type { CommonKey } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en, type AgentChainKey } from '../src/client/locales.ts'
import { jumpBehavior, locatorBars, scrollToCard, useActiveBar } from '../src/client/locator.ts'
import { CARD_PAGE, useRenderedCount, useSentinelAppend } from '../src/client/stream.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const DICTIONARY: Readonly<Record<AgentChainKey | CommonKey, string>> = { ...commonEn, ...en }

function t(key: AgentChainKey | CommonKey, params?: Record<string, unknown>): string {
  return DICTIONARY[key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : `{${name}}`
  })
}

/** One card with the fields a test does not state defaulted to a quiet read. */
function card(id: string, kind: ChainCard['kind'], text: string): ChainCard {
  return { id, kind, title: { copy: 'intent', text }, startedAt: 0, status: 'ok', evidenceSeqs: [] }
}

/** IntersectionObserver stub whose entries a test drives by hand. */
class ObserverStub {
  static instances: ObserverStub[] = []

  readonly observed: Element[] = []
  disconnected = false

  constructor(readonly callback: IntersectionObserverCallback) {
    ObserverStub.instances.push(this)
  }

  observe(element: Element): void { this.observed.push(element) }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true
    this.observed.length = 0
  }

  takeRecords(): IntersectionObserverEntry[] { return [] }

  report(target: Element, isIntersecting: boolean): void {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

beforeEach(() => { ObserverStub.instances = [] })

/** One rendered card row carrying the identity the locator looks for. */
function row(id: string, scrollIntoView: () => void): HTMLElement {
  const element = document.createElement('li')
  element.dataset.cardId = id
  Object.defineProperty(element, 'scrollIntoView', { value: scrollIntoView, configurable: true })
  return element
}

describe('locatorBars', () => {
  it('keeps prompt and change bars in event order with their list indexes', () => {
    const bars = locatorBars([
      { ...card('change:2', 'change', 'a.ts modified'), evidenceSeqs: [2] },
      card('intent:1', 'intent', 'inspect the catalog'),
      { ...card('prompt:0', 'prompt', 'fix the redirect'), evidenceSeqs: [1] },
    ], t, path => path)
    expect(bars).toEqual([
      { id: 'prompt:0', kind: 'prompt', title: 'fix the redirect', index: 2 },
      { id: 'change:2', kind: 'change', title: 'a.ts modified', index: 0 },
    ])
  })

  it('orders prompt and change bars together by evidence sequence', () => {
    const bars = locatorBars([
      { ...card('change:30', 'change', 'later.ts'), evidenceSeqs: [30] },
      { ...card('prompt:5', 'prompt', 'fix the redirect'), evidenceSeqs: [5] },
      { ...card('change:20', 'change', 'earlier.ts'), evidenceSeqs: [20] },
    ], t, path => path)
    expect(bars.map(bar => bar.id)).toEqual(['prompt:5', 'change:20', 'change:30'])
    expect(bars.map(bar => bar.index)).toEqual([1, 2, 0])
  })

  it('keeps a thinking card that folds out a change and drops one that folds out only recon', () => {
    const withChange: ChainCard = {
      ...card('thinking:1', 'thinking', 'start with the router'),
      children: [card('change:2', 'change', 'a.ts modified')],
    }
    const withoutChange: ChainCard = {
      ...card('thinking:3', 'thinking', 'keep reading'),
      children: [card('recon:4', 'recon', '2 files')],
    }
    const bars = locatorBars([withChange, withoutChange], t, path => path)
    expect(bars).toEqual([{ id: 'thinking:1', kind: 'thinking', title: 'start with the router', index: 0 }])
  })

  it('guides nothing in a chain without prompts or changes', () => {
    expect(locatorBars([card('intent:1', 'intent', 'inspect the catalog')], t, path => path)).toEqual([])
  })
})

describe('jumpBehavior', () => {
  it('scrolls smoothly when the reader allows motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    expect(jumpBehavior()).toBe('smooth')
  })

  it('jumps without motion when the reader asks for reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    expect(jumpBehavior()).toBe('auto')
  })

  it('scrolls smoothly where the platform has no media queries', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(jumpBehavior()).toBe('smooth')
  })
})

describe('scrollToCard', () => {
  it('scrolls the matching row to the scrollport top', () => {
    const scrollIntoView = vi.fn()
    const list = document.createElement('ol')
    list.append(row('intent:1', vi.fn()), row('change:2', scrollIntoView))
    scrollToCard(list, 'change:2')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
  })

  it('leaves a card that is not rendered yet alone', () => {
    expect(() => { scrollToCard(document.createElement('ol'), 'change:9') }).not.toThrow()
  })
})

describe('useActiveBar', () => {
  /** The bar identities a test guides with: the prompt and the change, not the skipped intent. */
  const BARS = ['prompt:0', 'change:2']

  it('reports nothing before an observation or without an observer', () => {
    const list = document.createElement('ol')
    const view = renderHook(() => useActiveBar(list, '0', BARS))
    expect(view.result.current).toBeUndefined()
    view.unmount()
  })

  it('reports nothing while the list is not mounted', () => {
    vi.stubGlobal('IntersectionObserver', ObserverStub)
    const view = renderHook(() => useActiveBar(null, '0', BARS))
    expect(view.result.current).toBeUndefined()
    expect(ObserverStub.instances).toHaveLength(0)
    view.unmount()
  })

  it('tracks the topmost guided card inside the reading band', () => {
    vi.stubGlobal('IntersectionObserver', ObserverStub)
    const list = document.createElement('ol')
    list.append(row('prompt:0', vi.fn()), row('intent:1', vi.fn()), row('change:2', vi.fn()))
    const view = renderHook(() => useActiveBar(list, '0', BARS))
    const observer = ObserverStub.instances[0]!
    // Only the guided rows are observed, so bar indexes never count skipped cards.
    expect(observer.observed).toEqual([list.children[0], list.children[2]])
    act(() => { observer.report(list.children[2]!, true) })
    expect(view.result.current).toBe(1)
    act(() => { observer.report(list.children[0]!, true) })
    expect(view.result.current).toBe(0)
    act(() => { observer.report(list.children[0]!, false) })
    act(() => { observer.report(list.children[2]!, false) })
    expect(view.result.current).toBeUndefined()
    view.unmount()
    expect(observer.disconnected).toBe(true)
  })

  it('skips a guided bar the current page has not rendered', () => {
    vi.stubGlobal('IntersectionObserver', ObserverStub)
    const list = document.createElement('ol')
    list.append(row('prompt:0', vi.fn()))
    const view = renderHook(() => useActiveBar(list, '0', BARS))
    const observer = ObserverStub.instances[0]!
    expect(observer.observed).toEqual([list.children[0]])
    act(() => { observer.report(list.children[0]!, true) })
    expect(view.result.current).toBe(0)
    view.unmount()
  })

  it('drops a reading from an earlier row set', () => {
    vi.stubGlobal('IntersectionObserver', ObserverStub)
    const list = document.createElement('ol')
    list.append(row('prompt:0', vi.fn()), row('change:2', vi.fn()))
    const view = renderHook(({ key }: { key: string }) => useActiveBar(list, key, BARS), { initialProps: { key: '0' } })
    act(() => { ObserverStub.instances[0]!.report(list.children[0]!, true) })
    expect(view.result.current).toBe(0)
    view.rerender({ key: '1' })
    // The new observer has not reported yet, so the previous reading is stale.
    expect(view.result.current).toBeUndefined()
    act(() => { ObserverStub.instances[1]!.report(list.children[1]!, true) })
    expect(view.result.current).toBe(1)
    view.unmount()
  })
})

describe('useRenderedCount', () => {
  it('renders one page first and appends another per request', () => {
    const view = renderHook(({ total }: { total: number }) => useRenderedCount(total, 'all:false'), {
      initialProps: { total: 100 },
    })
    expect(view.result.current.count).toBe(CARD_PAGE)
    act(() => { view.result.current.more() })
    expect(view.result.current.count).toBe(CARD_PAGE * 2)
    view.unmount()
  })

  it('never renders more cards than the list holds', () => {
    const view = renderHook(() => useRenderedCount(3, 'all:false'))
    expect(view.result.current.count).toBe(3)
    act(() => { view.result.current.more() })
    expect(view.result.current.count).toBe(3)
    view.unmount()
  })

  it('renders through a card the reader jumped to', () => {
    const view = renderHook(() => useRenderedCount(100, 'all:false'))
    act(() => { view.result.current.showThrough(59) })
    expect(view.result.current.count).toBe(60)
    act(() => { view.result.current.showThrough(2) })
    expect(view.result.current.count).toBe(60)
    view.unmount()
  })

  it('returns to the first page when the list changes', () => {
    const view = renderHook(({ key }: { key: string }) => useRenderedCount(100, key), {
      initialProps: { key: 'all:false' },
    })
    act(() => { view.result.current.more() })
    expect(view.result.current.count).toBe(CARD_PAGE * 2)
    view.rerender({ key: 'changes:false' })
    expect(view.result.current.count).toBe(CARD_PAGE)
    view.unmount()
  })
})

describe('useSentinelAppend', () => {
  it('appends when the sentinel scrolls into view', () => {
    vi.stubGlobal('IntersectionObserver', ObserverStub)
    const more = vi.fn()
    const view = renderHook(() => useSentinelAppend(more, CARD_PAGE))
    const sentinel = document.createElement('div')
    act(() => { view.result.current(sentinel) })
    const observer = ObserverStub.instances[0]!
    expect(observer.observed).toEqual([sentinel])
    act(() => { observer.report(sentinel, true) })
    expect(more).toHaveBeenCalledTimes(1)
    act(() => { observer.report(sentinel, false) })
    expect(more).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(observer.disconnected).toBe(true)
  })

  it('rebuilds the observer for the next page', () => {
    vi.stubGlobal('IntersectionObserver', ObserverStub)
    const more = vi.fn()
    const view = renderHook(({ page }: { page: number }) => useSentinelAppend(more, page), {
      initialProps: { page: CARD_PAGE },
    })
    const sentinel = document.createElement('div')
    act(() => { view.result.current(sentinel) })
    view.rerender({ page: CARD_PAGE * 2 })
    expect(ObserverStub.instances).toHaveLength(2)
    expect(ObserverStub.instances[0]!.disconnected).toBe(true)
    view.unmount()
  })

  it('leaves appending to the button where no observer exists', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const more = vi.fn()
    const view = renderHook(() => useSentinelAppend(more, CARD_PAGE))
    act(() => { view.result.current(document.createElement('div')) })
    expect(more).not.toHaveBeenCalled()
    view.unmount()
  })
})
