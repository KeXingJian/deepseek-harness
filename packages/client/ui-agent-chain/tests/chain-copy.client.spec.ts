/**
 * Review-chain presentation vocabulary: status dots, filters, expansion rows,
 * and the expandable decision.
 */
import { describe, expect, it } from 'vitest'
import type { ChainCard } from '@deepseek-ai/dsh-agent-activity'
import type { AgentChainKey } from '../src/client/locales.ts'
import { en } from '../src/client/locales.ts'
import {
  CHAIN_FILTERS, FILTER_KEYS, KIND_KEYS, KIND_TONES, SEVERITY_KEYS, SEVERITY_TONES,
  detailRows, filterCards, isExpandable, statusDot,
} from '../src/client/chain-copy.ts'

/** Translate through the shipped English dictionary. */
function t(key: AgentChainKey): string {
  return en[key]
}

/** One card with the fields a test does not state defaulted to a quiet read. */
function card(overrides: Partial<ChainCard> & Pick<ChainCard, 'kind' | 'title'>): ChainCard {
  return { id: `${overrides.kind}:1`, startedAt: 0, status: 'ok', evidenceSeqs: [], ...overrides }
}

describe('statusDot', () => {
  it('maps every card status onto the shared state dot', () => {
    expect(statusDot('ok')).toBe('done')
    expect(statusDot('error')).toBe('error')
    expect(statusDot('warning')).toBe('warning')
    expect(statusDot('running')).toBe('ongoing')
  })

  it('falls back to done for a card with no status', () => {
    expect(statusDot(undefined)).toBe('done')
  })
})

describe('filter vocabulary', () => {
  it('offers all three filters in display order with their keys', () => {
    expect(CHAIN_FILTERS).toEqual(['all', 'changes', 'risks'])
    expect(CHAIN_FILTERS.map(value => t(FILTER_KEYS[value])))
      .toEqual(['All', 'Changes only', 'Risks only'])
  })

  it('names and tones every card kind', () => {
    const kinds = ['intent', 'recon', 'change', 'verify', 'interrupt', 'result'] as const
    expect(kinds.map(kind => t(KIND_KEYS[kind])))
      .toEqual(['Intent', 'Recon', 'Change', 'Verify', 'Interrupt', 'Result'])
    expect(kinds.map(kind => KIND_TONES[kind]))
      .toEqual(['info', 'quiet', 'neutral', 'outline', 'warning', 'outline'])
  })

  it('names and tones every risk severity', () => {
    const severities = ['danger', 'warn', 'info'] as const
    expect(severities.map(severity => t(SEVERITY_KEYS[severity]))).toEqual(['Blocker', 'Warning', 'Note'])
    expect(severities.map(severity => SEVERITY_TONES[severity])).toEqual(['danger', 'warning', 'info'])
  })
})

describe('filterCards', () => {
  const cards = [
    card({ kind: 'intent', title: 'plan' }),
    card({ kind: 'change', title: 'edit a.ts', status: 'ok' }),
    card({ kind: 'verify', title: 'go test', status: 'error' }),
    card({ kind: 'interrupt', title: 'approval', status: 'warning' }),
  ]

  it('keeps the whole list for the default filter', () => {
    expect(filterCards(cards, 'all')).toBe(cards)
  })

  it('keeps only changes for the changes filter', () => {
    expect(filterCards(cards, 'changes').map(entry => entry.kind)).toEqual(['change'])
  })

  it('keeps failed and warned cards for the risks filter', () => {
    expect(filterCards(cards, 'risks').map(entry => entry.title)).toEqual(['go test', 'approval'])
  })
})

describe('detailRows', () => {
  it('lists every recorded fact with a localized label', () => {
    const rows = detailRows(card({
      kind: 'change',
      title: 'modified a.ts',
      meta: { path: 'src/a.ts', command: 'go test', tool: 'edit', op: 'update', files: 2, searches: 3 },
    }), t)
    expect(rows).toEqual([
      { label: 'Path', value: 'src/a.ts' },
      { label: 'Command', value: 'go test' },
      { label: 'Tool', value: 'edit' },
      { label: 'Operation', value: 'modified' },
      { label: 'Files', value: '2' },
      { label: 'Searches', value: '3' },
    ])
  })

  it('shows an unrecognized operation verbatim', () => {
    expect(detailRows(card({ kind: 'change', title: 'x', meta: { op: 'rename' } }), t))
      .toEqual([{ label: 'Operation', value: 'rename' }])
  })

  it('omits zero counts and non-string facts', () => {
    expect(detailRows(card({ kind: 'recon', title: 'read', meta: { files: 0, searches: 0, tool: 7 } }), t))
      .toEqual([])
  })

  it('reports nothing for a card without facts', () => {
    expect(detailRows(card({ kind: 'result', title: 'done' }), t)).toEqual([])
  })
})

describe('isExpandable', () => {
  it('expands for recorded text, facts, or evidence', () => {
    expect(isExpandable(card({ kind: 'intent', title: 'x', detail: 'why' }), [])).toBe(true)
    expect(isExpandable(card({ kind: 'change', title: 'x' }), [{ label: 'Path', value: 'a.ts' }])).toBe(true)
    expect(isExpandable(card({ kind: 'verify', title: 'x', evidenceSeqs: [4] }), [])).toBe(true)
  })

  it('stays closed for a card with nothing behind it', () => {
    expect(isExpandable(card({ kind: 'result', title: 'done' }), [])).toBe(false)
  })
})
