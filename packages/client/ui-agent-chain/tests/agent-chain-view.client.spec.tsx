// @vitest-environment jsdom
/**
 * Review-chain view: the waiting state, card rows, per-card disclosure, the
 * three filters, and the risk banner.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChainCard, RiskFlag } from '@deepseek-ai/dsh-agent-activity'
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

/** Render the view over one fixed snapshot. */
function renderView(cards: readonly ChainCard[], flags: readonly RiskFlag[] = []) {
  const chain: ChainSnapshot = { cards, flags }
  const useChain: AgentChainViewProps['useChain'] = selector => selector(chain)
  return render(<AgentChainView useChain={useChain} t={t} />)
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

  it('reveals facts, evidence, and detail text on demand', () => {
    renderView([card_])
    const toggle = screen.getByRole('button', { name: 'Show evidence' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('src/a.ts')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide evidence' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('renamed the index helper')).toBeTruthy()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('created')).toBeTruthy()
    expect(screen.getByText('Evidence')).toBeTruthy()
    expect(screen.getByText('#12 · #18')).toBeTruthy()
  })

  it('hides the detail again when toggled off', () => {
    renderView([card_])
    fireEvent.click(screen.getByRole('button', { name: 'Show evidence' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide evidence' }))
    expect(screen.queryByText('src/a.ts')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show evidence' })).toBeTruthy()
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
