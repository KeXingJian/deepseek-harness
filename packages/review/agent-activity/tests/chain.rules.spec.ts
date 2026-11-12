import { describe, expect, it } from 'vitest'
import { chainFromSpans } from '../src/index.ts'
import type { ActivitySpan, ChainCard } from '../src/index.ts'

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

/** Every change card on the chain, flattened out of its thinking-card parent. */
function changeCards(result: ReturnType<typeof chainFromSpans>): ChainCard[] {
  const flatten = (cards: readonly ChainCard[]): ChainCard[] =>
    cards.flatMap(card => [card, ...(card.children === undefined ? [] : flatten(card.children))])
  return flatten(result.cards).filter(card => card.kind === 'change')
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
    expect(result.cards[0]?.title).toEqual({ copy: 'intent', text: intent.slice(0, 60) })
  })

  it('renders the human prompt before the intent, cited by its own event', () => {
    const result = chainFromSpans([
      span(2, 'turn', 'turn:1', { attributes: { prompt: '修复登录页', promptSeq: 1, intent: '检查登录流程' } }),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'prompt', title: { copy: 'prompt', text: '修复登录页' }, evidenceSeqs: [1], meta: { prompt: '修复登录页' } },
      { kind: 'intent', title: { copy: 'intent', text: '检查登录流程' } },
    ])
  })

  it('renders a prompt card for a turn without an intent', () => {
    const result = chainFromSpans([span(1, 'turn', 'turn:1', { attributes: { prompt: '看下构建失败' } })])
    expect(result.cards[0]).toMatchObject({ kind: 'prompt', evidenceSeqs: [1] })
  })

  it('truncates a long prompt', () => {
    const prompt = 'x'.repeat(80)
    const result = chainFromSpans([span(1, 'turn', 'turn:1', { attributes: { prompt } })])
    expect(result.cards[0]?.title).toEqual({ copy: 'prompt', text: prompt.slice(0, 60) })
  })
})

describe('thinking cards', () => {
  it('renders a thinking card per step, cited by the assistant message', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: '先看路由\n再改表单', thinkingSeq: 7 } }),
    ])
    expect(result.cards[0]).toMatchObject({
      kind: 'thinking',
      title: { copy: 'thinking', text: '先看路由 再改表单' },
      evidenceSeqs: [7],
      meta: { thinking: '先看路由\n再改表单' },
    })
  })

  it('cites the step when no assistant sequence was recorded', () => {
    const result = chainFromSpans([span(1, 'step', 'step:1:1', { attributes: { thinking: '思考' } })])
    expect(result.cards[0]?.evidenceSeqs).toEqual([1])
  })

  it('summarizes the actions of the same step', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: '读两个文件再改一个', thinkingSeq: 2 } }),
      tool(2, 'read', { path: 'src/a.ts' }),
      tool(3, 'grep', { pattern: 'x' }),
      tool(4, 'edit', { path: 'src/b.ts' }),
      tool(5, 'bash', { command: 'pnpm test' }),
      tool(6, 'list', {}),
      span(7, 'step', 'step:1:2', { attributes: { thinking: '下一步', thinkingSeq: 9 } }),
    ])
    expect(result.cards[0]?.actions).toEqual({ files: 1, searches: 1, changes: 1, verifications: 1 })
    expect(result.cards.filter(card => card.kind === 'thinking')).toHaveLength(2)
    expect(result.cards.filter(card => card.kind === 'thinking')[1]?.actions).toBeUndefined()
  })

  it('omits the action summary when the step only asked a human', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: '需要确认', thinkingSeq: 2 } }),
      tool(2, 'approval', {}),
    ])
    expect(result.cards[0]?.actions).toBeUndefined()
  })

  it('skips a step without recorded thinking', () => {
    const result = chainFromSpans([span(1, 'step', 'step:1:1', { attributes: { thinking: '   ' } })])
    expect(result.cards.map(card => card.kind)).toEqual(['result'])
  })
})

describe('non-tool cards', () => {
  it('renders subagent hand-offs in both settlement states', () => {
    const result = chainFromSpans([
      span(1, 'subagent', 'explorer'),
      span(2, 'subagent', 'reviewer', { status: 'error' }),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'recon', title: { copy: 'subagent', name: 'explorer' }, status: 'ok' },
      { kind: 'recon', title: { copy: 'subagent', name: 'reviewer' }, status: 'error' },
    ])
  })

  it('renders workflow phases in both settlement states', () => {
    const result = chainFromSpans([
      span(1, 'workflow', 'scan'),
      span(2, 'workflow', 'fix', { status: 'error' }),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'verify', title: { copy: 'workflowCompleted', name: 'scan' }, status: 'ok' },
      { kind: 'verify', title: { copy: 'workflowFailed', name: 'fix' }, status: 'error' },
    ])
  })

  it('renders a human interrupt with elapsed seconds, and zero while running', () => {
    const result = chainFromSpans([
      tool(1, 'approval', {}, { startTime: 0, endTime: 4200 }),
      tool(2, 'ask_user', {}),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'interrupt', title: { copy: 'interrupt', seconds: 4 }, status: 'warning' },
      { kind: 'interrupt', title: { copy: 'interrupt', seconds: 0 } },
    ])
  })
})

describe('nested action cards', () => {
  it('nests the step’s action cards under its thinking card', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: '先看再改', thinkingSeq: 2 } }),
      tool(3, 'read', { path: 'src/a.ts' }),
      tool(4, 'edit', { path: 'src/b.ts' }),
      span(5, 'step', 'step:1:2'),
      tool(6, 'bash', { command: 'pnpm test' }),
    ])
    expect(result.cards.map(card => card.kind)).toEqual(['thinking', 'verify', 'result'])
    expect(result.cards[0]?.children?.map(card => card.kind)).toEqual(['recon', 'change'])
    expect(result.cards[0]?.children?.map(card => card.id)).toEqual(['recon:3', 'change:4'])
  })

  it('merges the nested cards of one step without leaving the step', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: '改两处', thinkingSeq: 2 } }),
      tool(3, 'edit', { path: 'src/b.ts' }),
      tool(4, 'read', { path: 'src/a.ts' }),
      tool(5, 'grep', { pattern: 'x' }),
      tool(6, 'edit', { path: 'src/b.ts' }),
      span(7, 'step', 'step:1:2', { attributes: { thinking: '再改同一文件', thinkingSeq: 8 } }),
      tool(9, 'edit', { path: 'src/b.ts' }),
    ])
    expect(result.cards[0]?.children?.map(card => card.kind)).toEqual(['change', 'recon'])
    expect(result.cards[0]?.children?.[1]?.title).toEqual({ copy: 'recon', files: 1, searches: 1 })
    expect(result.cards[1]?.children).toMatchObject([
      { kind: 'change', title: { copy: 'change', op: 'update', path: 'src/b.ts' } },
    ])
    expect(result.cards[1]?.children?.[0]?.repeat).toBeUndefined()
  })

  it('leaves actions flat when their step recorded no thinking', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1'),
      tool(2, 'edit', { path: 'src/b.ts' }),
    ])
    expect(result.cards.map(card => card.kind)).toEqual(['change', 'result'])
    expect(result.cards[0]?.children).toBeUndefined()
  })

  it('leaves a call without an owning step flat', () => {
    const result = chainFromSpans([tool(1, 'edit', { path: 'src/b.ts' })])
    expect(result.cards[0]).toMatchObject({ kind: 'change' })
    expect(result.cards[0]?.children).toBeUndefined()
  })

  it('gives a thinking card no children field when its step did nothing', () => {
    const result = chainFromSpans([span(1, 'step', 'step:1:1', { attributes: { thinking: '只想不做' } })])
    expect(result.cards[0]?.children).toBeUndefined()
  })

  it('counts nested changes and verifications in the closing card', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: '改一个文件再验证', thinkingSeq: 2 } }),
      tool(3, 'edit', { path: 'src/b.ts' }),
      tool(4, 'bash', { command: 'pnpm test' }),
    ])
    expect(result.cards.at(-1)).toMatchObject({ kind: 'result', title: { copy: 'result', files: 1, verifications: 1 } })
  })

  it('applies risk flags to nested change cards', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: '改测试再跑一遍', thinkingSeq: 2 } }),
      tool(3, 'edit', { path: 'tests/a.spec.ts' }),
      tool(4, 'bash', { command: 'pnpm test' }),
    ])
    expect(result.flags.map(flag => flag.code)).toContain('touches-tests')
    expect(result.cards[0]?.children?.[0]).toMatchObject({ kind: 'change', status: 'warning' })
  })

  it('reports an unverified nested change as a risk', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: '只改不验', thinkingSeq: 2 } }),
      tool(3, 'edit', { path: 'src/b.ts' }),
    ])
    expect(result.flags.map(flag => flag.code)).toContain('unverified')
    expect(result.cards.at(-1)?.status).toBe('error')
  })
})

describe('recorded diffs', () => {
  const HUNK = { path: 'src/b.ts', oldText: 'a', newText: 'b' }

  it('carries the diff recorded for a change call', () => {
    const result = chainFromSpans([tool(1, 'edit', { path: 'src/b.ts', callId: 'call-1' })], '', {
      'call-1': [HUNK],
    })
    expect(result.cards[0]?.diffs).toEqual([HUNK])
  })

  it('omits diffs for a call with no record, no id, or an empty record', () => {
    const result = chainFromSpans([
      tool(1, 'edit', { path: 'src/a.ts', callId: 'call-1' }),
      tool(2, 'edit', { path: 'src/b.ts' }),
      tool(3, 'edit', { path: 'src/c.ts', callId: 'call-2' }),
    ], '', { 'call-1': [], 'call-2': [HUNK] })
    expect(result.cards[0]?.diffs).toBeUndefined()
    expect(result.cards[1]?.diffs).toBeUndefined()
    expect(result.cards[2]?.diffs).toEqual([HUNK])
  })

  it('keeps a deletion’s diff on its error card', () => {
    const result = chainFromSpans([tool(1, 'delete', { path: 'src/b.ts', callId: 'call-1' })], '', {
      'call-1': [{ path: 'src/b.ts', oldText: 'gone', newText: '' }],
    })
    expect(result.cards[0]).toMatchObject({ kind: 'change', status: 'error' })
    expect(result.cards[0]?.diffs).toEqual([{ path: 'src/b.ts', oldText: 'gone', newText: '' }])
  })

  it('concatenates the diffs of one file merged into a single card', () => {
    const SECOND = { path: 'src/b.ts', oldText: 'b', newText: 'c' }
    const result = chainFromSpans([
      tool(1, 'edit', { path: 'src/b.ts', callId: 'call-1' }),
      tool(2, 'edit', { path: 'src/b.ts', callId: 'call-2' }),
    ], '', { 'call-1': [HUNK], 'call-2': [SECOND] })
    expect(result.cards[0]).toMatchObject({ kind: 'change', repeat: 2 })
    expect(result.cards[0]?.diffs).toEqual([HUNK, SECOND])
  })
})

describe('change cards', () => {
  it('treats a deletion as a change even when it runs through a shell tool', () => {
    const result = chainFromSpans([tool(1, 'bash', { op: 'delete', path: 'notes/old.md' })])
    expect(result.cards[0]).toMatchObject({
      kind: 'change',
      title: { copy: 'change', op: 'delete', path: 'notes/old.md' },
      status: 'error',
    })
  })

  it('recognises the delete tool name without an operation attribute', () => {
    const result = chainFromSpans([tool(1, 'delete', { path: 'notes/old.md' })])
    expect(result.cards[0]).toMatchObject({ kind: 'change', title: { copy: 'change', op: 'delete', path: 'notes/old.md' } })
  })

  it('renders created and updated files', () => {
    const result = chainFromSpans([
      tool(1, 'write', { path: 'src/new.ts', op: 'create' }),
      tool(2, 'edit', { path: 'src/old.ts' }),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'change', title: { copy: 'change', op: 'create', path: 'src/new.ts' } },
      { kind: 'change', title: { copy: 'change', op: 'update', path: 'src/old.ts' } },
    ])
  })

  it('falls back to the file attribute, then to the tool name', () => {
    const result = chainFromSpans([
      tool(1, 'write', { file: 'src/a.ts' }),
      tool(2, 'write', {}),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'change', title: { copy: 'change', op: 'update', path: 'src/a.ts' } },
      { kind: 'change', title: { copy: 'change', op: 'update', path: 'write' } },
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
      { kind: 'verify', title: { copy: 'verifyFailed', command: 'pnpm test', errorCode: 'ASSERT' }, status: 'error' },
      { kind: 'verify', title: { copy: 'verifyFailed', command: 'pnpm lint' }, status: 'error' },
      { kind: 'verify', title: { copy: 'verifyPassed', command: 'pnpm build' }, status: 'ok' },
      { kind: 'verify', title: { copy: 'verifyPassed', command: 'run_code' }, status: 'running' },
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
    expect(result.cards[0]).toMatchObject({ kind: 'recon', title: { copy: 'recon', files: 2, searches: 1 } })
  })

  it('summarizes search-only and unknown tools', () => {
    const searches = chainFromSpans([tool(1, 'grep', { pattern: 'a' }), tool(2, 'glob', { pattern: '*.ts' })])
    expect(searches.cards[0]?.title).toEqual({ copy: 'recon', files: 0, searches: 2 })

    const unknown = chainFromSpans([tool(1, 'mystery_tool', {})])
    expect(unknown.cards[0]).toMatchObject({ kind: 'recon', title: { copy: 'recon', files: 0, searches: 0 } })
  })
})

describe('merging rules', () => {
  it('keeps every event as a flat chronological card when merging is disabled', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { prompt: 'human request', promptSeq: 1, intent: 'first intent', intentSeq: 7 } }),
      span(2, 'step', 'step:1:1', { attributes: { thinking: 'planning', thinkingSeq: 3 } }),
      tool(4, 'edit', { path: 'src/a.ts' }),
      tool(5, 'edit', { path: 'src/a.ts' }),
      tool(6, 'grep', { pattern: 'x' }),
    ], '', {}, { merge: false })

    expect(result.cards.map(card => card.kind)).toEqual(['prompt', 'thinking', 'change', 'change', 'recon', 'intent', 'result'])
    expect(result.cards.slice(0, 6).map(card => card.evidenceSeqs[0])).toEqual([1, 3, 4, 5, 6, 7])
    expect(result.cards.slice(2, 4).map(card => card.repeat)).toEqual([undefined, undefined])
    expect(result.cards[1]?.children).toBeUndefined()
  })

  it('orders merged cards by their opening event sequence', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { prompt: 'human request', promptSeq: 1, intent: 'inspect the result', intentSeq: 5 } }),
      tool(3, 'edit', { path: 'src/a.ts' }),
      tool(4, 'bash', { command: 'pnpm test' }),
    ])

    expect(result.cards.slice(0, 4).map(card => card.kind)).toEqual(['prompt', 'change', 'verify', 'intent'])
  })

  it('merges repeated changes to one file and keeps the first position', () => {
    const result = chainFromSpans([
      tool(1, 'edit', { path: 'src/a.ts' }),
      tool(2, 'edit', { path: 'src/b.ts' }),
      tool(3, 'edit', { path: 'src/a.ts' }),
    ])
    expect(result.cards.slice(0, 2)).toMatchObject([
      { kind: 'change', title: { copy: 'change', op: 'update', path: 'src/a.ts' }, repeat: 2, evidenceSeqs: [1, 3] },
      { kind: 'change', title: { copy: 'change', op: 'update', path: 'src/b.ts' } },
    ])
  })

  it('keeps one edit card per prompt so a change stays between two prompts', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { prompt: 'first request', promptSeq: 1 } }),
      tool(2, 'edit', { path: 'src/a.ts' }),
      span(4, 'turn', 'turn:2', { attributes: { prompt: 'second request', promptSeq: 4 } }),
      tool(5, 'edit', { path: 'src/a.ts' }),
    ])
    expect(result.cards.map(card => card.id)).toEqual(['prompt:1', 'change:2', 'prompt:4', 'change:5', 'result:end'])
    expect(result.cards[1]).toMatchObject({ kind: 'change', evidenceSeqs: [2] })
    expect(result.cards[3]).toMatchObject({ kind: 'change', evidenceSeqs: [5] })
  })

  it('folds three or more successful verifications', () => {
    const result = chainFromSpans([
      tool(1, 'bash', { command: 'a' }),
      tool(2, 'bash', { command: 'b' }),
      tool(3, 'bash', { command: 'c' }),
    ])
    expect(result.cards[0]).toMatchObject({ kind: 'verify', title: { copy: 'verifyRun', count: 3 }, evidenceSeqs: [1, 2, 3] })
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
      title: { copy: 'result', files: 0, verifications: 0 },
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
    expect(result.cards.at(-1)).toMatchObject({ title: { copy: 'result', files: 1, verifications: 1 }, status: 'error' })
  })

  it('uses the last settlement time when one exists', () => {
    const result = chainFromSpans([tool(1, 'edit', { path: 'src/a.ts' }, { startTime: 100, endTime: 9000 })])
    expect(result.cards.at(-1)?.startedAt).toBe(9000)
  })
})


describe('change notes', () => {
  it('quotes the reasoning sentence that names the changed file', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '修复登录重定向' } }),
      span(2, 'step', 'step:1:1', {
        attributes: { thinking: '先看路由表。登录跳转写错了，改 auth.ts 里的重定向目标。再补一个用例。' },
      }),
      tool(3, 'edit', { path: 'src/auth.ts' }),
    ])
    expect(changeCards(result)[0]?.meta).toMatchObject({
      note: '登录跳转写错了，改 auth.ts 里的重定向目标',
      noteFrom: 'file',
    })
  })

  it('takes the whole sentence that names a bare file name', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: 'auth.ts 少了空值判断，读完再改。' } }),
      tool(2, 'edit', { path: 'src/deep/auth.ts' }),
    ])
    expect(changeCards(result)[0]?.meta).toMatchObject({ note: 'auth.ts 少了空值判断，读完再改', noteFrom: 'file' })
  })

  it('marks a note that names the file by its stem only', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: '把 redirect 的目标补上。' } }),
      tool(2, 'edit', { path: 'src/redirect.ts' }),
    ])
    expect(changeCards(result)[0]?.meta).toMatchObject({ note: '把 redirect 的目标补上', noteFrom: 'file' })
  })

  it('falls back to the step first sentence when it names no file', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '修复登录重定向' } }),
      span(2, 'step', 'step:1:1', { attributes: { thinking: '先看路由表\n再改表单' } }),
      tool(3, 'edit', { path: 'src/form.tsx' }),
    ])
    expect(changeCards(result)[0]?.meta).toMatchObject({ note: '先看路由表', noteFrom: 'step' })
  })

  it('falls back to the turn intent when the step recorded no reasoning', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '修复排序空数组问题。再加一个用例。' } }),
      tool(2, 'edit', { path: 'src/sort.ts' }),
    ])
    expect(changeCards(result)[0]?.meta).toMatchObject({ note: '修复排序空数组问题', noteFrom: 'intent' })
  })

  it('records no note when the session explained nothing', () => {
    const result = chainFromSpans([tool(1, 'edit', { path: 'src/a.ts' })])
    expect(changeCards(result)[0]?.meta).toEqual({ path: 'src/a.ts', op: 'update' })
  })

  it('caps the quoted text at the note limit', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: `${'改 a.ts 的边界'.repeat(40)}。` } }),
      tool(2, 'edit', { path: 'a.ts' }),
    ])
    expect(String(changeCards(result)[0]?.meta?.['note'])).toHaveLength(200)
  })

  it('joins the notes of two edits merged into one card', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '第一轮改 auth.ts 的跳转。' } }),
      tool(2, 'edit', { path: 'src/auth.ts' }),
      span(3, 'turn', 'turn:2', { attributes: { intent: '补充 auth.ts 的空值分支。' } }),
      tool(4, 'edit', { path: 'src/auth.ts' }),
    ])
    const merged = changeCards(result)[0]
    expect(merged?.repeat).toBe(2)
    expect(merged?.meta).toMatchObject({
      note: '第一轮改 auth.ts 的跳转 补充 auth.ts 的空值分支',
      noteFrom: 'intent',
    })
  })

  it('keeps one note when two edits of one file record the same sentence', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: '改 auth.ts。' } }),
      tool(2, 'edit', { path: 'src/auth.ts' }),
      tool(3, 'edit', { path: 'src/auth.ts' }),
    ])
    const merged = changeCards(result)[0]
    expect(merged?.repeat).toBe(2)
    expect(merged?.meta?.['note']).toBe('改 auth.ts')
  })

  it('keeps the first note when two layers merge into one card', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '修复登录跳转' } }),
      tool(2, 'edit', { path: 'src/auth.ts' }),
      span(3, 'step', 'step:1:2', { attributes: { thinking: 'auth.ts 少了一个空值分支。' } }),
      tool(4, 'edit', { path: 'src/auth.ts' }),
    ])
    expect(changeCards(result)[0]?.meta).toMatchObject({ note: '修复登录跳转', noteFrom: 'intent' })
  })

  it('adopts the note of a later edit when the earlier one recorded none', () => {
    const result = chainFromSpans([
      tool(1, 'edit', { path: 'src/auth.ts' }),
      span(2, 'turn', 'turn:1', { attributes: { intent: '修复登录跳转' } }),
      tool(3, 'edit', { path: 'src/auth.ts' }),
    ])
    expect(changeCards(result)[0]?.meta).toMatchObject({ note: '修复登录跳转', noteFrom: 'intent' })
  })

  it('does not reuse the previous turn reasoning for a later turn', () => {
    const result = chainFromSpans([
      span(1, 'turn', 'turn:1', { attributes: { intent: '修复登录跳转' } }),
      span(2, 'step', 'step:1:1', { attributes: { thinking: '先看 auth.ts 的跳转。' } }),
      span(3, 'turn', 'turn:2', { attributes: { intent: '第二个回合' } }),
      tool(4, 'edit', { path: 'src/b.ts' }),
    ])
    expect(changeCards(result)[0]?.meta).toMatchObject({ note: '第二个回合', noteFrom: 'intent' })
  })

  it('carries the note onto a deletion', () => {
    const result = chainFromSpans([
      span(1, 'step', 'step:1:1', { attributes: { thinking: 'old.md 已经没人引用，删掉。' } }),
      tool(2, 'bash', { op: 'delete', path: 'notes/old.md' }),
    ])
    expect(changeCards(result)[0]?.meta).toMatchObject({ op: 'delete', note: 'old.md 已经没人引用，删掉', noteFrom: 'file' })
  })
})
