// @vitest-environment jsdom
/**
 * Review-chain view: the waiting state, card rows, per-card disclosure, the
 * three filters, the risk banner, and the review links a card offers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ActivitySpan, ChainCard, RiskFlag } from '@deepseek-ai/dsh-agent-activity'
import { AgentChainView, type AgentChainViewProps } from '../src/client/AgentChainView.tsx'
import type { ChainSnapshot } from '../src/client/chain-view.ts'
import { en, type AgentChainKey } from '../src/client/locales.ts'

afterEach(cleanup)

/** Translate through the shipped English dictionary. */
function t(key: AgentChainKey): string {
  return en[key]
}

/** One card with the fields a test does not state defaulted to a quiet read. */
function card(overrides: Partial<ChainCard> & Pick<ChainCard, 'kind' | 'title'>): ChainCard {
  return { id: `${overrides.kind}:1`, startedAt: 0, status: 'ok', evidenceSeqs: [], ...overrides }
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
  return render(
    <AgentChainView
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
  it('renders one row per card with its kind, title, repeat, and status', () => {
    renderView([
      card({ kind: 'intent', title: 'inspect the catalog module' }),
      card({ kind: 'change', title: 'modified a.ts', repeat: 3, status: 'warning' }),
    ])
    expect(screen.getByText('Intent')).toBeTruthy()
    expect(screen.getByText('inspect the catalog module')).toBeTruthy()
    expect(screen.getByText('Change')).toBeTruthy()
    expect(screen.getByText('modified a.ts')).toBeTruthy()
    expect(screen.getByText('×3')).toBeTruthy()
    expect(document.querySelector('[data-kind="change"]')?.getAttribute('data-status')).toBe('warning')
  })

  it('offers no disclosure for a card with nothing behind it', () => {
    renderView([card({ kind: 'result', title: 'done' })])
    expect(screen.queryByRole('button', { name: 'Show evidence' })).toBeNull()
  })
})

describe('card disclosure', () => {
  const card_ = card({
    kind: 'change',
    title: 'modified a.ts',
    detail: 'renamed the index helper',
    meta: { path: 'src/a.ts', op: 'create', files: 2 },
    evidenceSeqs: [12, 18],
  })
  const spans = [span(12, 'write'), span(18, 'bash', 'error')]

  it('reveals facts, evidence, and detail text on demand', () => {
    renderView([card_], [], { spans })
    const toggle = screen.getByRole('button', { name: 'Show evidence' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('src/a.ts')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide evidence' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('renamed the index helper')).toBeTruthy()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('created')).toBeTruthy()
    expect(screen.getByText('Evidence')).toBeTruthy()
    expect(screen.getByText('#12')).toBeTruthy()
    expect(screen.getByText('write')).toBeTruthy()
    expect(screen.getByText('#18')).toBeTruthy()
    expect(screen.getByText('bash')).toBeTruthy()
  })

  it('hides the detail again when toggled off', () => {
    renderView([card_], [], { spans })
    fireEvent.click(screen.getByRole('button', { name: 'Show evidence' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide evidence' }))
    expect(screen.queryByText('src/a.ts')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show evidence' })).toBeTruthy()
  })
})

describe('review links', () => {
  it('opens the path a change card records', () => {
    const openFile = vi.fn()
    renderView(
      [card({ kind: 'change', title: 'modified a.ts', meta: { path: 'src/a.ts' }, evidenceSeqs: [] })],
      [],
      { openFile },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show evidence' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open in preview src/a.ts' }))
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('opens a file named by a risk flag', () => {
    const openFile = vi.fn()
    renderView([card({ kind: 'change', title: 'modified a.ts' })], [
      { code: 'tests-changed', severity: 'danger', reason: 'test files were modified', evidenceFiles: ['tests/a.spec.ts'] },
    ], { openFile })
    fireEvent.click(screen.getByRole('button', { name: 'Open in preview tests/a.spec.ts' }))
    expect(openFile).toHaveBeenCalledWith('tests/a.spec.ts')
  })

  it('opens a cited tool call in the view that inspects calls', () => {
    const inspectCall = vi.fn()
    renderView(
      [card({ kind: 'verify', title: 'go test passed', evidenceSeqs: [7] })],
      [],
      { spans: [span(7, 'bash', 'ok', { callId: 'call-7' })], inspectCall },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show evidence' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show in Trajectory #7' }))
    expect(inspectCall).toHaveBeenCalledWith('call-7')
  })

  it('leaves a cited span inert without a call identity or an inspector', () => {
    renderView(
      [card({ kind: 'intent', title: 'inspect the catalog module', evidenceSeqs: [3, 4] })],
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
  const cards = [
    card({ kind: 'intent', title: 'inspect the catalog module' }),
    card({ kind: 'change', title: 'modified a.ts' }),
    card({ kind: 'verify', title: 'go test failed', status: 'error' }),
  ]

  it('starts on the complete chain', () => {
    renderView(cards)
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('go test failed')).toBeTruthy()
  })

  it('keeps only changes', () => {
    renderView(cards)
    fireEvent.click(screen.getByRole('button', { name: 'Changes only' }))
    expect(screen.getByText('modified a.ts')).toBeTruthy()
    expect(screen.queryByText('go test failed')).toBeNull()
  })

  it('keeps only risky cards', () => {
    renderView(cards)
    fireEvent.click(screen.getByRole('button', { name: 'Risks only' }))
    expect(screen.getByText('go test failed')).toBeTruthy()
    expect(screen.queryByText('inspect the catalog module')).toBeNull()
  })

  it('explains an empty selection', () => {
    renderView([card({ kind: 'intent', title: 'inspect the catalog module' })])
    fireEvent.click(screen.getByRole('button', { name: 'Risks only' }))
    expect(screen.getByText('Nothing matches this filter')).toBeTruthy()
  })
})

describe('risk banner', () => {
  it('lists each risk with its severity, reason, and files', () => {
    renderView([card({ kind: 'change', title: 'modified a.ts' })], [
      { code: 'tests-changed', severity: 'danger', reason: 'test files were modified', evidenceFiles: ['tests/a.spec.ts'] },
      { code: 'out-of-scope', severity: 'info', reason: 'touched an unrelated file', evidenceFiles: [] },
    ])
    expect(screen.getByLabelText('Review risks')).toBeTruthy()
    expect(screen.getByText('Blocker')).toBeTruthy()
    expect(screen.getByText('test files were modified')).toBeTruthy()
    expect(screen.getByText('tests/a.spec.ts')).toBeTruthy()
    expect(screen.getByText('Note')).toBeTruthy()
    expect(screen.getByText('touched an unrelated file')).toBeTruthy()
  })

  it('renders no banner without risks', () => {
    renderView([card({ kind: 'change', title: 'modified a.ts' })])
    expect(screen.queryByLabelText('Review risks')).toBeNull()
  })
})
