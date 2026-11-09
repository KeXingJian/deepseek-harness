import { describe, expect, it } from 'vitest'
import { chainFromSpans } from '../src/index.ts'
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

describe('intent cards', () => {
  it('drops a turn without an intent and ignores supporting spans', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: {} }),
      span(2, 'turn', 'turn:2', { attributes: { intent: '   ' } }),
      span(3, 'step', 'step:1'),
      span(4, 'request', 'request:1'),
      span(5, 'compaction', 'compaction:1'),
    ])
    expect(result.cards.map(card => card.kind)).toEqual(['result'])
  })

  it('truncates a long intent to sixty characters', () => {
    const intent = 'x'.repeat(80)
    const result = chainFromSpans([span(1, 'turn', 'turn:1', { attributes: { intent } })])
    expect(result.cards[0]?.title).toHaveLength(60)
  })
})

describe('non-tool cards', () => {
  it('renders subagent hand-offs in both settlement states', () => {
    const result = chainFromSpans([
      span(1, 'subagent', 'explorer'),
      span(2, 'subagent', 'reviewer', { status: 'error' }),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'recon', title: '交给子代理：explorer', status: 'ok' },
      { kind: 'recon', title: '交给子代理：reviewer', status: 'error' },
    ])
  })

  it('renders workflow phases in both settlement states', () => {
    const result = chainFromSpans([
      span(1, 'workflow', 'scan'),
      span(2, 'workflow', 'fix', { status: 'error' }),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'verify', title: 'scan 完成', status: 'ok' },
      { kind: 'verify', title: 'fix 失败', status: 'error' },
    ])
  })

  it('renders a human interrupt with elapsed seconds, and zero while running', () => {
    const result = chainFromSpans([
      tool(1, 'approval', {}, { startTime: 0, endTime: 4200 }),
      tool(2, 'ask_user', {}),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'interrupt', title: '请求人工确认，等待 4s', status: 'warning' },
      { kind: 'interrupt', title: '请求人工确认，等待 0s' },
    ])
  })
})

describe('change cards', () => {
  it('treats a deletion as a change even when it runs through a shell tool', () => {
    const result = chainFromSpans([tool(1, 'bash', { op: 'delete', path: 'notes/old.md' })])
    expect(result.cards[0]).toMatchObject({ kind: 'change', title: '删除 notes/old.md', status: 'error' })
  })

  it('recognises the delete tool name without an operation attribute', () => {
    const result = chainFromSpans([tool(1, 'delete', { path: 'notes/old.md' })])
    expect(result.cards[0]).toMatchObject({ kind: 'change', title: '删除 notes/old.md' })
  })

  it('renders created and updated files', () => {
    const result = chainFromSpans([
      tool(1, 'write', { path: 'src/new.ts', op: 'create' }),
      tool(2, 'edit', { path: 'src/old.ts' }),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'change', title: '新建 src/new.ts' },
      { kind: 'change', title: '修改 src/old.ts' },
    ])
  })

  it('falls back to the file attribute, then to the tool name', () => {
    const result = chainFromSpans([
      tool(1, 'write', { file: 'src/a.ts' }),
      tool(2, 'write', {}),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'change', title: '修改 src/a.ts' },
      { kind: 'change', title: '修改 write' },
    ])
  })
})

describe('verification cards', () => {
  it('renders failure codes, bare failures, success and running state', () => {
    const result = chainFromSpans([
      tool(1, 'bash', { command: 'pnpm test', errorCode: 'ASSERT' }, { status: 'error' }),
      tool(2, 'bash', { command: 'pnpm lint' }, { status: 'error' }),
      tool(3, 'bash', { command: 'pnpm build' }),
      tool(4, 'run_code', {}, { status: 'running' }),
    ])
    expect(result.cards.slice(0, 4)).toMatchObject([
      { kind: 'verify', title: 'pnpm test 失败：ASSERT', status: 'error' },
      { kind: 'verify', title: 'pnpm lint 失败', status: 'error' },
      { kind: 'verify', title: 'pnpm build 通过', status: 'ok' },
      { kind: 'verify', title: 'run_code 通过', status: 'running' },
    ])
  })
})

describe('look-around cards', () => {
  it('counts files and searches in one merged card', () => {
    const result = chainFromSpans([
      tool(1, 'read', { path: 'src/a.ts' }),
      tool(2, 'grep', { pattern: 'foo' }),
      tool(3, 'read', { path: 'src/b.ts' }),
      tool(4, 'list', {}),
    ])
    expect(result.cards[0]).toMatchObject({ kind: 'recon', title: '查看了 2 个文件，检索 1 次' })
  })

  it('summarizes search-only and unknown tools', () => {
    const searches = chainFromSpans([tool(1, 'grep', { pattern: 'a' }), tool(2, 'glob', { pattern: '*.ts' })])
    expect(searches.cards[0]?.title).toBe('检索 2 次')

    const unknown = chainFromSpans([tool(1, 'mystery_tool', {})])
    expect(unknown.cards[0]).toMatchObject({ kind: 'recon', title: '查看' })
  })
})

describe('merging rules', () => {
  it('merges repeated changes to one file and keeps the first position', () => {
    const result = chainFromSpans([
      tool(1, 'edit', { path: 'src/a.ts' }),
      tool(2, 'edit', { path: 'src/b.ts' }),
      tool(3, 'edit', { path: 'src/a.ts' }),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'change', title: '修改 src/a.ts', repeat: 2, evidenceSeqs: [1, 3] },
      { kind: 'change', title: '修改 src/b.ts' },
    ])
  })

  it('folds three or more successful verifications', () => {
    const result = chainFromSpans([
      tool(1, 'bash', { command: 'a' }),
      tool(2, 'bash', { command: 'b' }),
      tool(3, 'bash', { command: 'c' }),
    ])
    expect(result.cards[0]).toMatchObject({ kind: 'verify', title: '验证 3 次，全部通过', evidenceSeqs: [1, 2, 3] })
  })

  it('keeps failed verifications standalone', () => {
    const result = chainFromSpans([
      tool(1, 'bash', { command: 'a' }),
      tool(2, 'bash', { command: 'a' }, { status: 'error' }),
      tool(3, 'bash', { command: 'a' }),
    ])
    expect(result.cards.map(card => card.kind)).toEqual(['verify', 'verify', 'verify', 'result'])
  })

  it('suppresses a near-duplicate intent', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '修复排序空数组问题' } }),
      span(2, 'turn', 'turn:2', { attributes: { intent: '修复排序空数组的问题' } }),
    ])
    expect(result.cards.filter(card => card.kind === 'intent')).toHaveLength(1)
  })

  it('treats identical and very short intents as duplicates', () => {
    const identical = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '修复 bug' } }),
      span(2, 'turn', 'turn:2', { attributes: { intent: '修复 bug' } }),
    ])
    expect(identical.cards.filter(card => card.kind === 'intent')).toHaveLength(1)

    const short = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: 'a' } }),
      span(2, 'turn', 'turn:2', { attributes: { intent: 'b' } }),
    ])
    expect(short.cards.filter(card => card.kind === 'intent')).toHaveLength(2)
  })

  it('forces a new intent after a failed verification', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '修复排序空数组问题' } }),
      tool(2, 'bash', { command: 'test' }, { status: 'error' }),
      span(3, 'turn', 'turn:2', { attributes: { intent: '修复排序空数组问题' } }),
    ])
    expect(result.cards.filter(card => card.kind === 'intent')).toHaveLength(2)
  })

  it('forces a new intent after a human interrupt', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '修复排序空数组问题' } }),
      tool(2, 'approval', {}),
      span(3, 'turn', 'turn:2', { attributes: { intent: '修复排序空数组问题' } }),
    ])
    expect(result.cards.filter(card => card.kind === 'intent')).toHaveLength(2)
  })
})

describe('display ceiling', () => {
  it('compresses look-around cards until the chain fits', () => {
    const spans: ActivitySpan[] = []
    for (let index = 0; index < 20; index += 1) {
      spans.push(tool(index * 2 + 1, 'read', { path: `src/${String(index)}.ts` }))
      spans.push(tool(index * 2 + 2, 'edit', { path: `src/${String(index)}.ts` }))
    }
    const result = chainFromSpans(spans)
    expect(result.cards).toHaveLength(30)
    expect(result.cards.filter(card => card.kind === 'recon')).toHaveLength(9)
  })

  it('drops a lone look-around card when the chain is still too long', () => {
    const spans: ActivitySpan[] = [tool(1, 'read', { path: 'src/a.ts' })]
    for (let index = 0; index < 31; index += 1) {
      spans.push(tool(index + 2, 'edit', { path: `src/${String(index)}.ts` }))
    }
    const result = chainFromSpans(spans)
    expect(result.cards.filter(card => card.kind === 'recon')).toHaveLength(0)
  })
})

describe('result card', () => {
  it('summarizes an empty session', () => {
    const result = chainFromSpans([])
    expect(result.cards).toEqual([{
      id: 'result:end',
      kind: 'result',
      title: '本次改动 0 个文件，0 次验证',
      startedAt: 0,
      status: 'ok',
      evidenceSeqs: [],
    }])
  })

  it('marks a change without successful verification as an error', () => {
    const result = chainFromSpans([
      tool(1, 'edit', { path: 'src/a.ts' }),
      tool(2, 'bash', { command: 'test' }, { status: 'error' }),
    ])
    expect(result.cards.at(-1)).toMatchObject({ title: '本次改动 1 个文件，1 次验证', status: 'error' })
  })

  it('uses the last settlement time when one exists', () => {
    const result = chainFromSpans([tool(1, 'edit', { path: 'src/a.ts' }, { startTime: 100, endTime: 9000 })])
    expect(result.cards.at(-1)?.startedAt).toBe(9000)
  })
})
