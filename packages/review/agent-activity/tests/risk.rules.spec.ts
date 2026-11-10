import { describe, expect, it } from 'vitest'
import { chainFromSpans, reviewFlags } from '../src/index.ts'
import type { ActivitySpan } from '../src/index.ts'

/** Build one span with a stable start time derived from its sequence. */
function span(seq: number, kind: ActivitySpan['kind'], name: string, extra: Partial<ActivitySpan> = {}): ActivitySpan {
  return { seq, kind, name, startTime: seq * 100, status: 'ok', ...extra }
}

/** Build one tool span. */
function tool(
  seq: number,
  name: string,
  attributes: Readonly<Record<string, string | number | boolean>> = {},
  extra: Partial<ActivitySpan> = {},
): ActivitySpan {
  return span(seq, 'tool', name, { attributes, ...extra })
}

describe('touches-tests', () => {
  it('flags a changed test file', () => {
    const result = chainFromSpans([tool(1, 'edit', { path: 'packages/x/tests/a.spec.ts' })])
    expect(result.flags).toContainEqual(expect.objectContaining({ code: 'touches-tests', severity: 'warn' }))
  })

  it('does not flag ordinary sources', () => {
    const result = chainFromSpans([tool(1, 'edit', { path: 'packages/x/src/a.ts' })])
    expect(result.flags.filter(flag => flag.code === 'touches-tests')).toEqual([])
  })
})

describe('touches-ci', () => {
  it('flags workflow and build configuration changes', () => {
    const result = chainFromSpans([
      tool(1, 'edit', { path: '.github/workflows/ci.yml' }),
      tool(2, 'edit', { path: 'ci/pipeline.yml' }),
      tool(3, 'edit', { path: 'tsconfig.json' }),
    ])
    expect(result.flags.find(flag => flag.code === 'touches-ci')?.evidenceFiles).toEqual([
      '.github/workflows/ci.yml',
      'ci/pipeline.yml',
      'tsconfig.json',
    ])
  })
})

describe('deletes', () => {
  it('flags a deletion even without a path attribute', () => {
    const result = chainFromSpans([tool(1, 'delete')])
    expect(result.flags).toContainEqual(expect.objectContaining({
      code: 'deletes',
      severity: 'danger',
      reason: { copy: 'deletes', count: 1 },
      evidenceFiles: ['delete'],
    }))
  })
})

describe('out-of-scope', () => {
  it('flags an in-place edit of a file the session never saw', () => {
    const result = chainFromSpans([tool(1, 'edit', { path: 'src/unseen.ts' })])
    expect(result.flags).toContainEqual(expect.objectContaining({
      code: 'out-of-scope',
      evidenceFiles: ['src/unseen.ts'],
    }))
  })

  it('keeps a file the session read, or the task named', () => {
    const read = chainFromSpans([
      tool(1, 'read', { path: 'src/seen.ts' }),
      tool(2, 'edit', { path: 'src/seen.ts' }),
    ])
    expect(read.flags.filter(flag => flag.code === 'out-of-scope')).toEqual([])

    const named = chainFromSpans([tool(1, 'edit', { path: 'src/named.ts' })], '请修改 src/named.ts')
    expect(named.flags.filter(flag => flag.code === 'out-of-scope')).toEqual([])
  })

  it('matches a directory-shaped read path', () => {
    const result = chainFromSpans([
      tool(1, 'read', { path: 'src' }),
      tool(2, 'edit', { path: 'src/deep/file.ts' }),
    ])
    expect(result.flags.filter(flag => flag.code === 'out-of-scope')).toEqual([])
  })
})

describe('unverified', () => {
  it('flags changes without a passing verification', () => {
    const result = chainFromSpans([
      tool(1, 'edit', { path: 'src/a.ts' }),
      tool(2, 'bash', { command: 'test' }, { status: 'error' }),
    ])
    expect(result.flags).toContainEqual(expect.objectContaining({ code: 'unverified', severity: 'danger' }))
  })

  it('stays quiet once a verification passes', () => {
    const result = chainFromSpans([
      tool(1, 'edit', { path: 'src/a.ts' }),
      tool(2, 'bash', { command: 'test' }),
    ])
    expect(result.flags.filter(flag => flag.code === 'unverified')).toEqual([])
  })
})

describe('gave-up', () => {
  it('flags repeated failures followed by more edits', () => {
    const result = chainFromSpans([
      tool(1, 'bash', { command: 'pnpm test' }, { status: 'error' }),
      tool(2, 'bash', { command: 'pnpm test' }, { status: 'error' }),
      tool(3, 'edit', { path: 'src/a.ts' }),
    ])
    expect(result.flags).toContainEqual(expect.objectContaining({
      code: 'gave-up',
      severity: 'warn',
      evidenceFiles: ['pnpm test'],
    }))
  })

  it('stays quiet for a single failure', () => {
    const result = chainFromSpans([
      tool(1, 'bash', { command: 'pnpm test' }, { status: 'error' }),
      tool(2, 'edit', { path: 'src/a.ts' }),
    ])
    expect(result.flags.filter(flag => flag.code === 'gave-up')).toEqual([])
  })

  it('falls back to the tool name when the failed command was not recorded', () => {
    const result = chainFromSpans([
      tool(1, 'bash', {}, { status: 'error' }),
      tool(2, 'bash', {}, { status: 'error' }),
      tool(3, 'edit', { path: 'src/a.ts' }),
    ])
    expect(result.flags).toContainEqual(expect.objectContaining({ code: 'gave-up', evidenceFiles: ['bash'] }))
  })
})

describe('plan-churn', () => {
  it('flags five distinct intents', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '先看排序实现' } }),
      span(2, 'turn', 'turn:2', { attributes: { intent: '改一版比较器' } }),
      span(3, 'turn', 'turn:3', { attributes: { intent: '补空数组测试' } }),
      span(4, 'turn', 'turn:4', { attributes: { intent: '调整日志输出' } }),
      span(5, 'turn', 'turn:5', { attributes: { intent: '收尾清理注释' } }),
    ])
    expect(result.flags).toContainEqual(expect.objectContaining({ code: 'plan-churn', severity: 'info' }))
  })

  it('stays quiet below five intents', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '先看排序实现' } }),
      span(2, 'turn', 'turn:2', { attributes: { intent: '改一版比较器' } }),
    ])
    expect(result.flags.filter(flag => flag.code === 'plan-churn')).toEqual([])
  })
})

describe('ordering and empty input', () => {
  it('orders danger before warn before info', () => {
    const result = chainFromSpans([
      tool(1, 'edit', { path: 'tests/a.spec.ts' }),
      tool(2, 'delete', { path: 'notes/old.md' }),
    ])
    expect(result.flags.map(flag => flag.severity)).toEqual(['danger', 'danger', 'warn', 'info'])
  })

  it('reports no flags for an empty chain', () => {
    expect(reviewFlags([], [], '')).toEqual([])
  })

  it('treats a caller-supplied card without meta as an unnamed change', () => {
    const flags = reviewFlags([], [{
      id: 'change:1',
      kind: 'change',
      title: { copy: 'change', op: 'update', path: '' },
      startedAt: 0,
      status: 'ok',
      evidenceSeqs: [1],
    }], '')
    expect(flags.map(flag => flag.code)).toEqual(['unverified'])
  })
})
