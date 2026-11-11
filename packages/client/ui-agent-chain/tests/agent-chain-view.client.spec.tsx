// @vitest-environment jsdom
/**
 * Review-chain view: the waiting state, card rows, per-card disclosure, the
 * three filters, the risk banner, and the review links a card offers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ActivitySpan, ChainCard, ChainTitle, RiskFlag } from '@deepseek-ai/dsh-agent-activity'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CommonKey } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AgentChainView, type AgentChainViewProps } from '../src/client/AgentChainView.tsx'
import type { ChainSnapshot } from '../src/client/chain-view.ts'
import { en, type AgentChainKey } from '../src/client/locales.ts'

afterEach(cleanup)

/** The Session the view renders; the fixture list holds no row for it, so paths stay as recorded. */
const SESSION = 'session-1' as SessionId

/** A Session list with no rows: no workspace root is known, so paths are not shortened. */
const NO_SESSIONS: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }

/** Shipped English copy: the namespace's own entries over the shared common vocabulary. */
const DICTIONARY: Readonly<Record<AgentChainKey | CommonKey, string>> = { ...commonEn, ...en }

/** Translate through the shipped English dictionary, interpolating its placeholders. */
function t(key: AgentChainKey | CommonKey, params?: Record<string, unknown>): string {
  return DICTIONARY[key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : `{${name}}`
  })
}

/** One card with the fields a test does not state defaulted to a quiet read. */
function card(overrides: Partial<ChainCard> & Pick<ChainCard, 'kind' | 'title'>): ChainCard {
  return { id: `${overrides.kind}:1`, startedAt: 0, status: 'ok', evidenceSeqs: [], ...overrides }
}

/** One intent card, the only kind whose title is recorded text. */
function intent(text: string): ChainCard {
  return card({ kind: 'intent', title: { copy: 'intent', text } })
}

/** One change card; the title carries the operation and the target. */
function change(path: string): ChainCard {
  return card({ kind: 'change', title: { copy: 'change', op: 'update', path } })
}

/** One failing verification card. */
function failedVerify(command: string): ChainCard {
  return card({ kind: 'verify', title: { copy: 'verifyFailed', command }, status: 'error' })
}

/** One contributing span as the Definition publishes it. */
function span(
  seq: number,
  name: string,
  status: ActivitySpan['status'] = 'ok',
  attributes?: Readonly<Record<string, string>>,
): ActivitySpan {
  return { seq, kind: 'tool', name, startTime: 0, status, ...(attributes === undefined ? {} : { attributes }) }
}

/** Optional collaborators a test drives instead of the real Session shell. */
interface ViewOptions {
  readonly spans?: readonly ActivitySpan[]
  readonly openFile?: (path: string) => void
  readonly inspectCall?: (callId: string) => void
}

/** Render the view over one fixed snapshot. */
function renderView(
  cards: readonly ChainCard[],
  flags: readonly RiskFlag[] = [],
  options: ViewOptions = {},
) {
  const chain: ChainSnapshot = { cards, flags, spans: options.spans ?? [] }
  const useChain: AgentChainViewProps['useChain'] = selector => selector(chain)
  const useSessions: AgentChainViewProps['useSessions'] = selector => selector(NO_SESSIONS)
  return render(
    <AgentChainView
      sessionId={SESSION}
      useSessions={useSessions}
      useChain={useChain}
      t={t}
      openFile={options.openFile ?? (() => {})}
      inspectCall={options.inspectCall}
    />,
  )
}

describe('waiting state', () => {
  it('renders the waiting line and no controls for an empty chain', () => {
    renderView([])
    expect(screen.getByText('No activity recorded yet')).toBeTruthy()
    expect(screen.queryByRole('group')).toBeNull()
  })
})

describe('card rows', () => {
  it('renders one row per card with its localized title, repeat, and status', () => {
    renderView([
      intent('inspect the catalog module'),
      card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'a.ts' }, repeat: 3, status: 'warning' }),
    ])
    expect(screen.getByText('Intent')).toBeTruthy()
    expect(screen.getByText('inspect the catalog module')).toBeTruthy()
    expect(screen.getByText('Change')).toBeTruthy()
    expect(screen.getByText('a.ts modified')).toBeTruthy()
    expect(screen.getByText('×3')).toBeTruthy()
    expect(document.querySelector('[data-kind="change"]')?.getAttribute('data-status')).toBe('warning')
  })

  it('offers no disclosure for a card with nothing behind it', () => {
    const title: ChainTitle = { copy: 'result', files: 0, verifications: 0 }
    renderView([card({ kind: 'result', title })])
    expect(screen.getByText('0 files changed, 0 verifications')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show evidence' })).toBeNull()
  })

  it('gives every card kind its own glyph and visible label', () => {
    const titles: Readonly<Record<ChainCard['kind'], ChainTitle>> = {
      prompt: { copy: 'prompt', text: 'fix the redirect' },
      thinking: { copy: 'thinking', text: 'start with the router' },
      intent: { copy: 'intent', text: 'inspect the catalog' },
      recon: { copy: 'recon', files: 1, searches: 0 },
      change: { copy: 'change', op: 'update', path: 'a.ts' },
      verify: { copy: 'verifyPassed', command: 'go test' },
      interrupt: { copy: 'interrupt', seconds: 3 },
      result: { copy: 'result', files: 1, verifications: 1 },
    }
    const kinds = Object.keys(titles) as readonly ChainCard['kind'][]
    renderView(kinds.map((kind, index) => card({ id: `${kind}:${String(index)}`, kind, title: titles[kind] })))
    const glyphs = kinds.map((kind) => {
      const row = document.querySelector(`[data-kind="${kind}"]`)
      expect(row).toBeTruthy()
      return row?.querySelector('svg')?.getAttribute('data-icon')
    })
    expect(new Set(glyphs).size).toBe(kinds.length)
    for (const glyph of glyphs) expect(glyph).toMatch(/^dsw-icon-/)
  })
})

describe('card disclosure', () => {
  const card_ = card({
    kind: 'change',
    title: { copy: 'change', op: 'update', path: 'src/a.ts' },
    meta: { path: 'src/a.ts', op: 'create', files: 2 },
    evidenceSeqs: [12, 18],
  })
  const spans = [span(12, 'write'), span(18, 'bash', 'error')]

  it('reveals the recorded facts and evidence on demand', () => {
    renderView([card_], [], { spans })
    const toggle = screen.getByRole('button', { name: 'Show evidence' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('src/a.ts')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide evidence' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('created')).toBeTruthy()
    expect(screen.getByText('Evidence')).toBeTruthy()
    expect(screen.getByText('#12')).toBeTruthy()
    expect(screen.getByText('write')).toBeTruthy()
    expect(screen.getByText('#18')).toBeTruthy()
    expect(screen.getByText('bash')).toBeTruthy()
  })

  it('hides the facts again when toggled off', () => {
    renderView([card_], [], { spans })
    fireEvent.click(screen.getByRole('button', { name: 'Show evidence' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide evidence' }))
    expect(screen.queryByText('src/a.ts')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show evidence' })).toBeTruthy()
  })

  it('shows a thinking card with its step actions and reveals the recorded text', () => {
    renderView([
      card({
        kind: 'prompt',
        title: { copy: 'prompt', text: 'fix the login redirect' },
        meta: { prompt: 'fix the login redirect and keep the tests green' },
      }),
      card({
        kind: 'thinking',
        title: { copy: 'thinking', text: 'start with the router' },
        meta: { thinking: 'start with the router, then the form' },
        actions: { files: 1, searches: 0, changes: 1, verifications: 0 },
      }),
    ])
    expect(screen.getByText('read 1 files · changed 1 files')).toBeTruthy()
    for (const toggle of screen.getAllByRole('button', { name: 'Show evidence' })) fireEvent.click(toggle)
    expect(screen.getByText('Prompt text')).toBeTruthy()
    expect(screen.getByText('fix the login redirect and keep the tests green')).toBeTruthy()
    expect(screen.getAllByText('Thinking')).toHaveLength(2)
    expect(screen.getByText('start with the router, then the form')).toBeTruthy()
  })
})

describe('nested action cards', () => {
  const diff = { path: 'src/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }

  /** One thinking card whose step changed one file and read another. */
  function thinkingWithChildren(): ChainCard {
    return card({
      id: 'thinking:2',
      kind: 'thinking',
      title: { copy: 'thinking', text: 'start with the router' },
      meta: { thinking: 'start with the router, then the form' },
      actions: { files: 1, searches: 0, changes: 1, verifications: 0 },
      children: [
        card({
          id: 'change:3',
          kind: 'change',
          title: { copy: 'change', op: 'update', path: 'src/a.ts' },
          meta: { path: 'src/a.ts', op: 'update' },
          diffs: [diff],
        }),
        card({ id: 'recon:4', kind: 'recon', title: { copy: 'recon', files: 1, searches: 0 }, meta: { files: 1 } }),
      ],
    })
  }

  it('renders the step actions as child cards without expanding the parent', () => {
    renderView([thinkingWithChildren()])
    expect(screen.getByText('src/a.ts modified')).toBeTruthy()
    expect(screen.getByText('1 files')).toBeTruthy()
    expect(screen.getByText('start with the router')).toBeTruthy()
  })

  it('expands a child card on its own', () => {
    renderView([thinkingWithChildren()])
    // Parent, change child, and recon child each own a toggle.
    const toggles = screen.getAllByRole('button', { name: 'Show evidence' })
    expect(toggles).toHaveLength(3)
    fireEvent.click(toggles[1] as HTMLElement)
    expect(screen.getByText('const a = 1')).toBeTruthy()
    expect(screen.getByText('const a = 2')).toBeTruthy()
    expect(screen.queryByText('start with the router, then the form')).toBeNull()
  })

  it('shows a recorded diff on a change card that records nothing else', () => {
    renderView([card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'src/a.ts' }, diffs: [diff] })])
    fireEvent.click(screen.getByRole('button', { name: 'Show evidence' }))
    expect(screen.getByText('const a = 1')).toBeTruthy()
    expect(screen.getByText('const a = 2')).toBeTruthy()
    expect(document.querySelector('[data-diff]')).toBeTruthy()
  })
})

describe('review links', () => {
  it('opens the path a change card records', () => {
    const openFile = vi.fn()
    renderView(
      [card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'src/a.ts' }, meta: { path: 'src/a.ts' } })],
      [],
      { openFile },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show evidence' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open in preview src/a.ts' }))
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('opens a file named by a risk flag', () => {
    const openFile = vi.fn()
    renderView([change('a.ts')], [
      { code: 'touches-tests', severity: 'danger', reason: { copy: 'touchesTests' }, evidenceFiles: ['tests/a.spec.ts'] },
    ], { openFile })
    fireEvent.click(screen.getByRole('button', { name: 'Open in preview tests/a.spec.ts' }))
    expect(openFile).toHaveBeenCalledWith('tests/a.spec.ts')
  })

  it('opens a cited tool call in the view that inspects calls', () => {
    const inspectCall = vi.fn()
    renderView(
      [card({ kind: 'verify', title: { copy: 'verifyPassed', command: 'go test' }, evidenceSeqs: [7] })],
      [],
      { spans: [span(7, 'bash', 'ok', { callId: 'call-7' })], inspectCall },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show evidence' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show in Trajectory #7' }))
    expect(inspectCall).toHaveBeenCalledWith('call-7')
  })

  it('leaves a cited span inert without a call identity or an inspector', () => {
    renderView(
      [card({ kind: 'intent', title: { copy: 'intent', text: 'inspect the catalog module' }, evidenceSeqs: [3, 4] })],
      [],
      {
        spans: [span(3, 'turn:1'), span(4, 'bash', 'ok', { callId: 'call-4' })],
        inspectCall: vi.fn(),
      },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show evidence' }))
    expect(screen.getByText('#3')).toBeTruthy()
    expect(screen.getByText('turn:1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show in Trajectory #3' })).toBeNull()
  })
})

describe('filters', () => {
  const cards = [intent('inspect the catalog module'), change('a.ts'), failedVerify('go test')]

  it('starts on the complete chain', () => {
    renderView(cards)
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('go test failed')).toBeTruthy()
  })

  it('keeps only changes', () => {
    renderView(cards)
    fireEvent.click(screen.getByRole('button', { name: 'Changes only' }))
    expect(screen.getByText('a.ts modified')).toBeTruthy()
    expect(screen.queryByText('go test failed')).toBeNull()
  })

  it('keeps only risky cards', () => {
    renderView(cards)
    fireEvent.click(screen.getByRole('button', { name: 'Risks only' }))
    expect(screen.getByText('go test failed')).toBeTruthy()
    expect(screen.queryByText('inspect the catalog module')).toBeNull()
  })

  it('explains an empty selection', () => {
    renderView([intent('inspect the catalog module')])
    fireEvent.click(screen.getByRole('button', { name: 'Risks only' }))
    expect(screen.getByText('Nothing matches this filter')).toBeTruthy()
  })
})

describe('risk rail', () => {
  const flags: readonly RiskFlag[] = [
    { code: 'touches-tests', severity: 'danger', reason: { copy: 'touchesTests' }, evidenceFiles: ['tests/a.spec.ts'] },
    { code: 'out-of-scope', severity: 'info', reason: { copy: 'outOfScope' }, evidenceFiles: [] },
  ]

  it('lists each risk with its severity, reason, and files', () => {
    renderView([change('a.ts')], flags)
    expect(screen.getByLabelText('Review risks')).toBeTruthy()
    expect(screen.getByText('Blocker')).toBeTruthy()
    expect(screen.getByText('Changed test files')).toBeTruthy()
    expect(screen.getByText('tests/a.spec.ts')).toBeTruthy()
    expect(screen.getByText('Note')).toBeTruthy()
    expect(screen.getByText('These files appear in no task description or exploration (inferred)')).toBeTruthy()
  })

  it('renders no rail without risks', () => {
    renderView([change('a.ts')])
    expect(screen.queryByLabelText('Review risks')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show risks' })).toBeNull()
  })

  it('collapses to a count handle and expands again on demand', () => {
    renderView([change('a.ts')], flags)
    const hide = screen.getByRole('button', { name: 'Hide risks' })
    expect(hide.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(hide)
    expect(screen.queryByLabelText('Review risks')).toBeNull()
    expect(screen.queryByText('Changed test files')).toBeNull()
    const show = screen.getByRole('button', { name: 'Show risks' })
    expect(show.getAttribute('aria-expanded')).toBe('false')
    expect(show.textContent).toBe('2')
    fireEvent.click(show)
    expect(screen.getByLabelText('Review risks')).toBeTruthy()
    expect(screen.getByText('Changed test files')).toBeTruthy()
  })

  it('keeps the collapsed state independent of the card filters', () => {
    renderView([intent('inspect the catalog module'), change('a.ts')], flags)
    fireEvent.click(screen.getByRole('button', { name: 'Hide risks' }))
    fireEvent.click(screen.getByRole('button', { name: 'Changes only' }))
    expect(screen.getByRole('button', { name: 'Show risks' })).toBeTruthy()
    expect(screen.getByText('a.ts modified')).toBeTruthy()
  })
})

describe('recon visibility', () => {
  const recon = card({ id: 'recon:2', kind: 'recon', title: { copy: 'recon', files: 2, searches: 1 } })

  it('shows recon cards by default and hides them on request', () => {
    renderView([intent('inspect the catalog module'), recon])
    const toggle = screen.getByRole('button', { name: 'Hide recon' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('2 files, 1 searches')).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Show recon' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText('2 files, 1 searches')).toBeNull()
    expect(screen.getByText('inspect the catalog module')).toBeTruthy()
  })

  it('reports an empty list when hiding recon leaves nothing', () => {
    renderView([recon])
    fireEvent.click(screen.getByRole('button', { name: 'Hide recon' }))
    expect(screen.getByText('Nothing matches this filter')).toBeTruthy()
  })
})

describe('card locator', () => {
  /** A chain long enough to reach past the rendered page. */
  function manyCards(count: number): ChainCard[] {
    return Array.from({ length: count }, (_entry, index) => card({
      id: `intent:${String(index)}`,
      kind: 'intent',
      title: { copy: 'intent', text: `step ${String(index)}` },
    }))
  }

  /** jsdom implements no scrollIntoView; the locator calls it on the target card. */
  const scrollIntoView = vi.fn()
  beforeEach(() => {
    Element.prototype.scrollIntoView = scrollIntoView
  })
  afterEach(() => { scrollIntoView.mockClear() })

  it('offers one bar per rendered card and jumps to the chosen one', () => {
    renderView([intent('inspect the catalog module'), change('a.ts')])
    const rail = screen.getByLabelText('Jump between chain cards')
    const bars = within(rail).getAllByRole('button')
    expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual([
      'Jump to inspect the catalog module',
      'Jump to a.ts modified',
    ])
    fireEvent.click(bars[1] as HTMLElement)
    expect(scrollIntoView.mock.instances.at(-1)).toBe(document.querySelector('[data-card-id="change:1"]'))
  })

  it('renders the rest of the chain when the reader asks for more', () => {
    renderView(manyCards(45))
    expect(screen.queryByText('step 44')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show more cards (40/45)' }))
    expect(screen.getByText('step 44')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show more cards (40/45)' })).toBeNull()
  })

  it('renders through a distant card the reader jumps to', () => {
    renderView(manyCards(45))
    fireEvent.click(screen.getByRole('button', { name: 'Jump to step 44' }))
    expect(screen.getByText('step 44')).toBeTruthy()
    expect(scrollIntoView.mock.instances.at(-1)).toBe(document.querySelector('[data-card-id="intent:44"]'))
  })

  it('marks the bar of the card the reader is looking at', () => {
    const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = []
    vi.stubGlobal('IntersectionObserver', class {
      readonly targets: Element[] = []
      constructor(readonly callback: IntersectionObserverCallback) {
        observers.push(this)
      }

      observe(target: Element): void { this.targets.push(target) }

      unobserve(): void {}

      disconnect(): void {}

      takeRecords(): IntersectionObserverEntry[] { return [] }
    })
    renderView([intent('inspect the catalog module'), change('a.ts')])
    const observer = observers[0]!
    const row = document.querySelector('[data-card-id="change:1"]')!
    act(() => {
      observer.callback([{ target: row, isIntersecting: true } as IntersectionObserverEntry], observer as never)
    })
    vi.unstubAllGlobals()
    const rail = screen.getByLabelText('Jump between chain cards')
    const bars = within(rail).getAllByRole('button')
    expect(bars[1]?.getAttribute('aria-current')).toBe('location')
    expect(bars[0]?.hasAttribute('data-active')).toBe(false)
  })
})
