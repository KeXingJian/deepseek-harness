/**
 * Review-chain presentation vocabulary: status dots, controls, localized card
 * titles, expansion rows, and the expandable decision.
 */
import { describe, expect, it } from 'vitest'
import type { ActivitySpan, ChainCard, ChainTitle } from '@deepseek-ai/dsh-agent-activity'
import type { CommonKey } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en, type AgentChainKey } from '../src/client/locales.ts'
import { relativizeToCwd } from '@deepseek-ai/dsh-util-workspace-path'
import {
  KIND_GLYPHS, KIND_KEYS,
  actionSummary, cardDiffs, cardTitle, detailRows, diffLabels, evidenceSpans, hideReconCards,
  isExpandable, spanDot, statusDot,
} from '../src/client/chain-copy.ts'
import type { ChainPathLabel } from '../src/client/chain-copy.ts'

/** Shipped English copy: the namespace's own entries over the shared common vocabulary. */
const DICTIONARY: Readonly<Record<AgentChainKey | CommonKey, string>> = { ...commonEn, ...en }

/** Paths as recorded, for cases that assert copy rather than path shortening. */
const AS_RECORDED: ChainPathLabel = path => path

/** The workspace-relative rewriter the view supplies, over a fixture project root. */
const IN_PROJECT: ChainPathLabel = path => relativizeToCwd(path, '/proj')

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

describe('chain controls', () => {
  it('localizes both target timeline modes', () => {
    expect(t('merge.showChronological')).toBe('Show events chronologically')
    expect(t('merge.showMerged')).toBe('Show merged events')
  })

  it('names and tones every card kind', () => {
    const kinds = ['prompt', 'thinking', 'intent', 'recon', 'change', 'verify', 'interrupt', 'result'] as const
    expect(kinds.map(kind => t(KIND_KEYS[kind])))
      .toEqual(['Prompt', 'Thinking', 'Intent', 'Recon', 'Change', 'Verify', 'Interrupt', 'Result'])
    // 字形是区分类别的第一层；八种类别各有自己的图形。
    expect(new Set(kinds.map(kind => KIND_GLYPHS[kind])).size).toBe(kinds.length)
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
    expect(cardTitle(intent('inspect the catalog module'), t, AS_RECORDED)).toBe('inspect the catalog module')
  })

  it('shows a recorded human prompt verbatim', () => {
    expect(cardTitle(card({ kind: 'prompt', title: { copy: 'prompt', text: 'fix the login redirect' } }), t, AS_RECORDED))
      .toBe('fix the login redirect')
  })

  it('shows a recorded thinking line verbatim', () => {
    expect(cardTitle(card({ kind: 'thinking', title: { copy: 'thinking', text: 'start with the router' } }), t, AS_RECORDED))
      .toBe('start with the router')
  })

  it('names whichever look-around totals are positive', () => {
    const recon = (files: number, searches: number): ChainTitle => ({ copy: 'recon', files, searches })
    expect(cardTitle(card({ kind: 'recon', title: recon(2, 1) }), t, AS_RECORDED)).toBe('2 files, 1 searches')
    expect(cardTitle(card({ kind: 'recon', title: recon(3, 0) }), t, AS_RECORDED)).toBe('3 files')
    expect(cardTitle(card({ kind: 'recon', title: recon(0, 4) }), t, AS_RECORDED)).toBe('4 searches')
    expect(cardTitle(card({ kind: 'recon', title: recon(0, 0) }), t, AS_RECORDED)).toBe('Looked around')
  })

  it('names the compressed look-around card', () => {
    expect(cardTitle(card({ kind: 'recon', title: { copy: 'reconCollapsed' } }), t, AS_RECORDED))
      .toBe('Looked around and searched')
  })

  it('names a subagent hand-off', () => {
    expect(cardTitle(card({ kind: 'recon', title: { copy: 'subagent', name: 'explorer' } }), t, AS_RECORDED))
      .toBe('Handed to subagent: explorer')
  })

  it('names both workflow settlements', () => {
    expect(cardTitle(card({ kind: 'verify', title: { copy: 'workflowCompleted', name: 'scan' } }), t, AS_RECORDED))
      .toBe('scan completed')
    expect(cardTitle(card({ kind: 'verify', title: { copy: 'workflowFailed', name: 'fix' } }), t, AS_RECORDED))
      .toBe('fix failed')
  })

  it('names a human interrupt with its wait', () => {
    expect(cardTitle(card({ kind: 'interrupt', title: { copy: 'interrupt', seconds: 42 } }), t, AS_RECORDED))
      .toBe('Asked for approval, waited 42s')
  })

  it('names every file operation', () => {
    expect(cardTitle(card({ kind: 'change', title: { copy: 'change', op: 'create', path: 'a.ts' } }), t, AS_RECORDED))
      .toBe('a.ts created')
    expect(cardTitle(card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'a.ts' } }), t, AS_RECORDED))
      .toBe('a.ts modified')
    expect(cardTitle(card({ kind: 'change', title: { copy: 'change', op: 'delete', path: 'a.ts' } }), t, AS_RECORDED))
      .toBe('a.ts deleted')
  })

  it('shows a recorded absolute path relative to the project root', () => {
    expect(cardTitle(
      card({ kind: 'change', title: { copy: 'change', op: 'update', path: '/proj/src/a.ts' } }),
      t,
      IN_PROJECT,
    )).toBe('src/a.ts modified')
  })

  it('names a passing command', () => {
    expect(cardTitle(card({ kind: 'verify', title: { copy: 'verifyPassed', command: 'go test' } }), t, AS_RECORDED))
      .toBe('go test passed')
  })

  it('names a failing command with and without a recorded code', () => {
    expect(cardTitle(
      card({ kind: 'verify', title: { copy: 'verifyFailed', command: 'go test', errorCode: 'E1' } }),
      t,
      AS_RECORDED,
    )).toBe('go test failed: E1')
    expect(cardTitle(card({ kind: 'verify', title: { copy: 'verifyFailed', command: 'go test' } }), t, AS_RECORDED))
      .toBe('go test failed')
  })

  it('names a folded verification run and the closing summary', () => {
    expect(cardTitle(card({ kind: 'verify', title: { copy: 'verifyRun', count: 3 } }), t, AS_RECORDED))
      .toBe('3 verifications, all passed')
    expect(cardTitle(card({ kind: 'result', title: { copy: 'result', files: 2, verifications: 5 } }), t, AS_RECORDED))
      .toBe('2 files changed, 5 verifications')
  })
})

describe('actionSummary', () => {
  it('names every positive count in a fixed order', () => {
    expect(actionSummary({ files: 2, searches: 1, changes: 3, verifications: 4 }, t))
      .toBe('read 2 files · searched 1 times · changed 3 files · verified 4 times')
  })

  it('omits zero counts', () => {
    expect(actionSummary({ files: 0, searches: 2, changes: 0, verifications: 1 }, t))
      .toBe('searched 2 times · verified 1 times')
    expect(actionSummary({ files: 0, searches: 0, changes: 0, verifications: 0 }, t)).toBe('')
  })
})

describe('hideReconCards', () => {
  const cards = [
    intent('plan'),
    card({ kind: 'recon', title: { copy: 'recon', files: 1, searches: 0 } }),
    card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'a.ts' } }),
  ]

  it('keeps the whole list when recon stays visible', () => {
    expect(hideReconCards(cards, false)).toBe(cards)
  })

  it('drops every recon card when the reader hides recon', () => {
    expect(hideReconCards(cards, true).map(entry => entry.kind)).toEqual(['intent', 'change'])
  })

  it('keeps a parent with its remaining children and drops only the recon child', () => {
    const nested = card({
      kind: 'thinking',
      title: { copy: 'thinking', text: 'change the router' },
      children: [
        card({ id: 'recon:2', kind: 'recon', title: { copy: 'recon', files: 1, searches: 0 } }),
        card({ id: 'change:3', kind: 'change', title: { copy: 'change', op: 'update', path: 'a.ts' } }),
      ],
    })
    const [kept] = hideReconCards([nested], true)
    expect(kept?.id).toBe('thinking:1')
    expect(kept?.children?.map(entry => entry.id)).toEqual(['change:3'])
  })
})

describe('detailRows', () => {
  it('lists every recorded fact with a localized label', () => {
    const rows = detailRows(card({
      kind: 'change',
      title: { copy: 'change', op: 'update', path: 'src/a.ts' },
      meta: { path: 'src/a.ts', command: 'go test', tool: 'edit', op: 'update', files: 2, searches: 3 },
    }), t, AS_RECORDED)
    expect(rows).toEqual([
      { label: 'Path', value: 'src/a.ts', file: 'src/a.ts' },
      { label: 'Command', value: 'go test' },
      { label: 'Tool', value: 'edit' },
      { label: 'Operation', value: 'modified' },
      { label: 'Files', value: '2' },
      { label: 'Searches', value: '3' },
    ])
  })

  it('labels a change note by what the projection recorded about it', () => {
    const rows = detailRows(card({
      kind: 'change',
      title: { copy: 'change', op: 'update', path: 'src/a.ts' },
      meta: { path: 'src/a.ts', note: 'auth.ts 少了空值判断', noteFrom: 'file' },
    }), t, AS_RECORDED)
    expect(rows).toEqual([
      { label: 'Path', value: 'src/a.ts', file: 'src/a.ts' },
      { label: 'Why this change', value: 'auth.ts 少了空值判断' },
    ])
  })

  it('labels a plan and a turn goal differently from a named change', () => {
    const plan = detailRows(card({
      kind: 'change',
      title: { copy: 'change', op: 'create', path: 'b.ts' },
      meta: { note: '先看路由表', noteFrom: 'step' },
    }), t, AS_RECORDED)
    expect(plan).toEqual([{ label: 'Step context', value: '先看路由表' }])
    const goal = detailRows(card({
      kind: 'change',
      title: { copy: 'change', op: 'create', path: 'c.ts' },
      meta: { note: '修复排序', noteFrom: 'intent' },
    }), t, AS_RECORDED)
    expect(goal).toEqual([{ label: 'Turn intent', value: '修复排序' }])
  })

  it('falls back to the step label for a note without a recorded source', () => {
    expect(detailRows(card({
      kind: 'change',
      title: { copy: 'change', op: 'update', path: 'd.ts' },
      meta: { note: '改 d.ts' },
    }), t, AS_RECORDED)).toEqual([{ label: 'Step context', value: '改 d.ts' }])
  })

  it('shows the path relative to the project root but keeps the recorded one for opening', () => {
    expect(detailRows(card({
      kind: 'change',
      title: { copy: 'change', op: 'update', path: '/proj/src/a.ts' },
      meta: { path: '/proj/src/a.ts' },
    }), t, IN_PROJECT)).toEqual([{ label: 'Path', value: 'src/a.ts', file: '/proj/src/a.ts' }])
  })

  it('lists the recorded prompt and the thinking behind an intent', () => {
    expect(detailRows(card({
      kind: 'prompt',
      title: { copy: 'prompt', text: 'fix the login redirect' },
      meta: { prompt: 'fix the login redirect, and keep the tests green' },
    }), t, AS_RECORDED)).toEqual([{ label: 'Prompt text', value: 'fix the login redirect, and keep the tests green' }])

    expect(detailRows(card({
      kind: 'intent',
      title: { copy: 'intent', text: 'check the router' },
      meta: { thinking: 'start with the router, then the form' },
    }), t, AS_RECORDED)).toEqual([{ label: 'Thinking', value: 'start with the router, then the form' }])
  })

  it('shows an unrecognized operation verbatim', () => {
    expect(detailRows(
      card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'a.ts' }, meta: { op: 'rename' } }),
      t,
      AS_RECORDED,
    )).toEqual([{ label: 'Operation', value: 'rename' }])
  })

  it('omits zero counts and non-string facts', () => {
    expect(detailRows(card({
      kind: 'recon',
      title: { copy: 'recon', files: 0, searches: 0 },
      meta: { files: 0, searches: 0, tool: 7 },
    }), t, AS_RECORDED)).toEqual([])
  })

  it('reports nothing for a card without facts', () => {
    expect(detailRows(
      card({ kind: 'result', title: { copy: 'result', files: 0, verifications: 0 } }),
      t,
      AS_RECORDED,
    )).toEqual([])
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

  it('expands for a recorded diff', () => {
    const diff = { path: 'a.ts', oldText: 'a', newText: 'b' }
    expect(isExpandable(card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'a.ts' }, diffs: [diff] }), []))
      .toBe(true)
  })
})

describe('recorded diffs', () => {
  const DIFF = { path: 'src/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }

  it('hands a card’s recorded diffs to the diff block', () => {
    expect(cardDiffs(
      card({ kind: 'change', title: { copy: 'change', op: 'update', path: 'src/a.ts' }, diffs: [DIFF] }),
      AS_RECORDED,
    )).toEqual([DIFF])
  })

  it('shortens each hunk header the way the view reads paths', () => {
    const absolute = { path: '/proj/src/a.ts', oldText: 'a', newText: 'b' }
    expect(cardDiffs(
      card({ kind: 'change', title: { copy: 'change', op: 'update', path: '/proj/src/a.ts' }, diffs: [absolute] }),
      IN_PROJECT,
    )).toEqual([{ ...absolute, path: 'src/a.ts' }])
  })

  it('reports no diffs for a card that records none', () => {
    expect(cardDiffs(card({ kind: 'recon', title: { copy: 'recon', files: 1, searches: 0 } }), AS_RECORDED)).toEqual([])
  })

  it('localizes the diff card chrome from the shared vocabulary', () => {
    const labels = diffLabels(t)
    expect(labels).toMatchObject({
      codeLabel: 'Code block',
      wrapLabel: 'Wrap lines',
      unwrapLabel: 'Do not wrap lines',
      copy: 'Copy',
      copied: 'Copied',
      collapseAria: 'Collapse diff',
      collapse: 'Collapse',
    })
    expect(labels.expandAria(3)).toBe('Expand 3 more diff lines')
    expect(labels.expand(3)).toBe('… 3 more lines')
  })
})
