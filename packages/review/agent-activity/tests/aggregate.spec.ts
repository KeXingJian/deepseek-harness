import { describe, expect, it } from 'vitest'
import type { ActivitySpan } from '../src/index.ts'
import {
  emptyActivitySummary, openActivitySpan, settleActivitySpan, summarizeSpans,
} from '../src/index.ts'

/** One settled tool span. */
function toolSpan(overrides: Partial<ActivitySpan> = {}): ActivitySpan {
  return { seq: 1, kind: 'tool', name: 'bash', startTime: 100, endTime: 175, status: 'ok', ...overrides }
}

describe('emptyActivitySummary', () => {
  it('starts every kind, status, and duration at zero', () => {
    const summary = emptyActivitySummary()
    expect(Object.values(summary.spansByKind).every(count => count === 0)).toBe(true)
    expect(Object.values(summary.spansByStatus).every(count => count === 0)).toBe(true)
    expect(Object.values(summary.durationByKind).every(count => count === 0)).toBe(true)
    expect(Object.keys(summary.spansByKind)).toEqual(['turn', 'step', 'request', 'tool', 'subagent', 'workflow', 'compaction'])
    expect(Object.keys(summary.spansByStatus)).toEqual(['running', 'ok', 'error', 'cancelled', 'interrupted'])
  })
})

describe('summarizeSpans', () => {
  it('counts a settled span by kind, status, and wall time', () => {
    const summary = summarizeSpans([toolSpan(), toolSpan({ seq: 2, kind: 'step', status: 'error', startTime: 0, endTime: 25 })])
    expect(summary.spansByKind.tool).toBe(1)
    expect(summary.spansByKind.step).toBe(1)
    expect(summary.spansByStatus.ok).toBe(1)
    expect(summary.spansByStatus.error).toBe(1)
    expect(summary.durationByKind.tool).toBe(75)
    expect(summary.durationByKind.step).toBe(25)
  })

  it('counts a running span without adding wall time', () => {
    const summary = summarizeSpans([{ ...toolSpan(), endTime: undefined, status: 'running' }])
    expect(summary.spansByStatus.running).toBe(1)
    expect(summary.spansByStatus.ok).toBe(0)
    expect(summary.durationByKind.tool).toBe(0)
  })

  it('returns the zero summary for no spans', () => {
    expect(summarizeSpans([])).toEqual(emptyActivitySummary())
  })
})

describe('openActivitySpan', () => {
  it('accounts one running span of its family without mutating the input', () => {
    const before = emptyActivitySummary()
    const after = openActivitySpan(before, { ...toolSpan(), endTime: undefined, status: 'running' })
    expect(after.spansByKind.tool).toBe(1)
    expect(after.spansByStatus.running).toBe(1)
    expect(after.durationByKind.tool).toBe(0)
    expect(before).toEqual(emptyActivitySummary())
  })
})

describe('settleActivitySpan', () => {
  const running: ActivitySpan = { ...toolSpan(), endTime: undefined, status: 'running' }
  const settled: ActivitySpan = { ...running, endTime: 180, status: 'ok' }

  it('moves the status count and adds the closed wall time', () => {
    const before = openActivitySpan(emptyActivitySummary(), running)
    const after = settleActivitySpan(before, running, settled)
    expect(after.spansByStatus.running).toBe(0)
    expect(after.spansByStatus.ok).toBe(1)
    expect(after.durationByKind.tool).toBe(80)
  })

  it('ignores an attribute-only update that keeps settlement unchanged', () => {
    const before = openActivitySpan(emptyActivitySummary(), settled)
    const attributed: ActivitySpan = { ...settled, attributes: { intent: 'why' } }
    expect(settleActivitySpan(before, settled, attributed)).toBe(before)
  })

  it('moves the status without adding wall time for an already-closed span', () => {
    const before = summarizeSpans([settled])
    const failed = settleActivitySpan(before, settled, { ...settled, status: 'error' })
    expect(failed.spansByStatus.ok).toBe(0)
    expect(failed.spansByStatus.error).toBe(1)
    expect(failed.durationByKind.tool).toBe(80)
  })

  it('never counts a wall time twice', () => {
    const before = openActivitySpan(emptyActivitySummary(), running)
    const once = settleActivitySpan(before, running, settled)
    expect(settleActivitySpan(once, settled, settled)).toBe(once)
    expect(once.durationByKind.tool).toBe(80)
  })
})
