/**
 * Review-chain presentation vocabulary: status dots, filters, localized card
 * titles and risk reasons, expansion rows, and the expandable decision.
 */
import { describe, expect, it } from 'vitest'
import type { ActivitySpan, ChainCard, ChainTitle, RiskFlag, RiskReason } from '@deepseek-ai/dsh-agent-activity'
import type { AgentChainKey } from '../src/client/locales.ts'
import { en } from '../src/client/locales.ts'
import {
  CHAIN_FILTERS, FILTER_KEYS, KIND_KEYS, KIND_TONES, SEVERITY_KEYS, SEVERITY_TONES,
  cardTitle, detailRows, evidenceSpans, filterCards, isExpandable, riskReason, spanDot, statusDot,
} from '../src/client/chain-copy.ts'

/** Translate through the shipped English dictionary, interpolating its placeholders. */
function t(key: AgentChainKey, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/g, (_match, name: string) => {
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

/** One risk flag carrying the finding under test. */
function flag(reason: RiskReason): RiskFlag {
  return { code: reason.copy, severity: 'warn', reason, evidenceFiles: [] }
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

describe('spanDot', () => {
  it('maps every span settlement onto the shared state dot', () => {
    expect(spanDot('running')).toBe('ongoing')
    expect(spanDot('ok')).toBe('done')
    expect(spanDot('error')).toBe('error')
  })

  it('reads a span that stopped before settling as a warning', () => {
    expect(spanDot('cancelled')).toBe('warning')
    expect(spanDot('interrupted')).toBe('warning')
  })
})

describe('cardTitle', () => {
  it('shows a recorded intent verbatim', () => {
    expect(cardTitle(intent('inspect the catalog module'), t)).toBe('inspect the catalog module')
  })

  it('names whichever look-around totals are positive', () => {
    const recon = (files: number, searches: number): ChainTitle => ({ copy: 'recon', files, searches })
    expect(cardTitle(card({ kind: 'recon', title: recon(2, 1) }), t)).toBe('2 files, 1 searches')
    expect(cardTitle(card({ kind: 'recon', title: recon(3, 0) }), t)).toBe('3 files')
    expect(cardTitle(card({ kind: 'recon', title: recon(0, 4) }), t)).toBe('4 searches')
    expect(cardTitle(card({ kind: 'recon', title: recon(0, 0) }), t)).toBe('Looked around')
  })

  it('names the compressed look-around card', () => {
    expect(cardTitle(card({ kind: 'recon', title: { copy: 'reconCollapsed' } }), t))
      .toBe('Looked around and searched')
  })

  it('names a subagent hand-off', () => {
    expect(cardTitle(card({ kind: 'recon', title: { copy: 'subagent', name: 'explorer' } }), t))
      .toBe('Handed to subagent: explorer')
  })

  it('names both workflow settlements', () => {
    expect(cardTitle(card({ kind: 'verify', title: { copy: 'workflowCompleted', name: 'scan' } }), t))
      .toBe('scan completed')
    expect(cardTitle(card({ kind: 'verify', title: { copy: 'workflowFailed', name: 'fix' } }), t))
      .toBe('fix failed')
  })

  it('names a human interrupt with its wait', () => {
    expect(cardTitle(card({ kind: 'interrupt', title: { copy: 'interrupt', seconds: 42 } }), t))
      .toBe('Asked for approval, waited 42s')
  })

  it('names every file operation', () => {
    expect(cardTitle(card({ kind: 'change', title: { copy: 'change', op: 'create', path: 'a.ts' } }), t))
      .toBe('a.ts created')
    expect(cardTitle(card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'a.ts' } }), t))
      .toBe('a.ts modified')
    expect(cardTitle(card({ kind: 'change', title: { copy: 'change', op: 'delete', path: 'a.ts' } }), t))
      .toBe('a.ts deleted')
  })

  it('names a passing command', () => {
    expect(cardTitle(card({ kind: 'verify', title: { copy: 'verifyPassed', command: 'go test' } }), t))
      .toBe('go test passed')
  })

  it('names a failing command with and without a recorded code', () => {
    expect(cardTitle(card({ kind: 'verify', title: { copy: 'verifyFailed', command: 'go test', errorCode: 'E1' } }), t))
      .toBe('go test failed: E1')
    expect(cardTitle(card({ kind: 'verify', title: { copy: 'verifyFailed', command: 'go test' } }), t))
      .toBe('go test failed')
  })

  it('names a folded verification run and the closing summary', () => {
    expect(cardTitle(card({ kind: 'verify', title: { copy: 'verifyRun', count: 3 } }), t))
      .toBe('3 verifications, all passed')
    expect(cardTitle(card({ kind: 'result', title: { copy: 'result', files: 2, verifications: 5 } }), t))
      .toBe('2 files changed, 5 verifications')
  })
})

describe('riskReason', () => {
  it('names every rule finding', () => {
    expect(riskReason(flag({ copy: 'touchesTests' }), t)).toBe('Changed test files')
    expect(riskReason(flag({ copy: 'touchesCi' }), t)).toBe('Changed CI or build configuration')
    expect(riskReason(flag({ copy: 'deletes', count: 2 }), t)).toBe('Deleted 2 files')
    expect(riskReason(flag({ copy: 'outOfScope' }), t))
      .toBe('These files appear in no task description or exploration (inferred)')
    expect(riskReason(flag({ copy: 'unverified' }), t)).toBe('Changes exist, but no verification passed')
    expect(riskReason(flag({ copy: 'gaveUp' }), t))
      .toBe('Kept editing after the same verification failed repeatedly')
    expect(riskReason(flag({ copy: 'planChurn', count: 5 }), t))
      .toBe('The objective changed 5 times in this session')
  })
})

describe('filterCards', () => {
  const cards = [
    intent('plan'),
    card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'a.ts' }, status: 'ok' }),
    card({ kind: 'verify', title: { copy: 'verifyFailed', command: 'go test' }, status: 'error' }),
    card({ kind: 'interrupt', title: { copy: 'interrupt', seconds: 1 }, status: 'warning' }),
  ]

  it('keeps the whole list for the default filter', () => {
    expect(filterCards(cards, 'all')).toBe(cards)
  })

  it('keeps only changes for the changes filter', () => {
    expect(filterCards(cards, 'changes').map(entry => entry.kind)).toEqual(['change'])
  })

  it('keeps failed and warned cards for the risks filter', () => {
    expect(filterCards(cards, 'risks').map(entry => entry.kind)).toEqual(['verify', 'interrupt'])
  })
})

describe('detailRows', () => {
  it('lists every recorded fact with a localized label', () => {
    const rows = detailRows(card({
      kind: 'change',
      title: { copy: 'change', op: 'update', path: 'src/a.ts' },
      meta: { path: 'src/a.ts', command: 'go test', tool: 'edit', op: 'update', files: 2, searches: 3 },
    }), t)
    expect(rows).toEqual([
      { label: 'Path', value: 'src/a.ts', file: 'src/a.ts' },
      { label: 'Command', value: 'go test' },
      { label: 'Tool', value: 'edit' },
      { label: 'Operation', value: 'modified' },
      { label: 'Files', value: '2' },
      { label: 'Searches', value: '3' },
    ])
  })

  it('shows an unrecognized operation verbatim', () => {
    expect(detailRows(card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'a.ts' }, meta: { op: 'rename' } }), t))
      .toEqual([{ label: 'Operation', value: 'rename' }])
  })

  it('omits zero counts and non-string facts', () => {
    expect(detailRows(card({
      kind: 'recon',
      title: { copy: 'recon', files: 0, searches: 0 },
      meta: { files: 0, searches: 0, tool: 7 },
    }), t)).toEqual([])
  })

  it('reports nothing for a card without facts', () => {
    expect(detailRows(card({ kind: 'result', title: { copy: 'result', files: 0, verifications: 0 } }), t)).toEqual([])
  })
})

describe('evidenceSpans', () => {
  const spans = [
    span(3, 'turn:1', 'ok'),
    span(7, 'bash', 'error', { callId: 'call-7' }),
    span(9, 'read', 'running'),
  ]

  it('reads the cited spans in evidence order', () => {
    const card_ = card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'a.ts' }, evidenceSeqs: [9, 7] })
    expect(evidenceSpans(card_, spans)).toEqual([
      { seq: 9, name: 'read', dot: 'ongoing', callId: undefined },
      { seq: 7, name: 'bash', dot: 'error', callId: 'call-7' },
    ])
  })

  it('keeps a turn span without a call identity', () => {
    expect(evidenceSpans(card({ kind: 'intent', title: { copy: 'intent', text: 'x' }, evidenceSeqs: [3] }), spans))
      .toEqual([{ seq: 3, name: 'turn:1', dot: 'done', callId: undefined }])
  })

  it('skips a cited sequence the snapshot no longer holds', () => {
    expect(evidenceSpans(card({ kind: 'intent', title: { copy: 'intent', text: 'x' }, evidenceSeqs: [3, 99] }), spans))
      .toEqual([{ seq: 3, name: 'turn:1', dot: 'done', callId: undefined }])
  })

  it('reports nothing for a card that cites nothing', () => {
    expect(evidenceSpans(card({ kind: 'result', title: { copy: 'result', files: 0, verifications: 0 } }), spans))
      .toEqual([])
  })
})

describe('isExpandable', () => {
  it('expands for facts or evidence', () => {
    expect(isExpandable(card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'a.ts' } }),
      [{ label: 'Path', value: 'a.ts' }])).toBe(true)
    expect(isExpandable(card({ kind: 'verify', title: { copy: 'verifyPassed', command: 'go test' }, evidenceSeqs: [4] }), []))
      .toBe(true)
  })

  it('stays closed for a card with nothing behind it', () => {
    expect(isExpandable(card({ kind: 'result', title: { copy: 'result', files: 0, verifications: 0 } }), [])).toBe(false)
  })
})
