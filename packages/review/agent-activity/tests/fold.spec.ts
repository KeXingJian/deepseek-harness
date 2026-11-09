import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { chainFromSpans, createActivityFolder, foldActivity } from '../src/index.ts'

/** Build a `turn/start` event. */
function turnStart(seq: number, time: number, turn: number): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time, data: { turn } }
}

/** Turn-end reasons the fixtures can record. */
const END_REASONS = {
  completed: { kind: 'completed' },
  blocked: { kind: 'blocked' },
  aborted: { kind: 'aborted', reason: { kind: 'legacy' } },
  error: { kind: 'error', error: { message: 'failed', code: 'LLM_FAILED' } },
} as const

/** Build a `turn/end` event for the named reason. */
function turnEnd(
  seq: number,
  time: number,
  turn: number,
  reason: keyof typeof END_REASONS,
): SessionEvent {
  return { type: 'turn/end', seq: SessionSeq(seq), time, data: { turn, reason: END_REASONS[reason] } }
}

/** Build a `step/start` event. */
function stepStart(seq: number, time: number, turn: number, step: number): SessionEvent {
  return { type: 'step/start', seq: SessionSeq(seq), time, data: { turn, step } }
}

/** Build a `step/end` event. */
function stepEnd(seq: number, time: number, turn: number, step: number): SessionEvent {
  return { type: 'step/end', seq: SessionSeq(seq), time, data: { turn, step } }
}

/** Build an `assistant/message` event carrying the given content blocks. */
function assistant(seq: number, time: number, turn: number, blocks: readonly ContentBlock[]): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time,
    surfaceOp: 'append',
    data: {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: blocks,
        source: { provider: 'test', model: 'test-model' },
      }),
      stream: [],
    },
  }
}

/** Build a `tool/call` event. */
function toolCall(seq: number, time: number, name: string, args: Record<string, unknown>, callId = 'call-1'): SessionEvent {
  return {
    type: 'tool/call',
    seq: SessionSeq(seq),
    time,
    data: { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: JSON.stringify(args) },
  }
}

/** Build a `tool/call` event with raw argument text. */
function rawToolCall(seq: number, time: number, name: string, argumentText: string): SessionEvent {
  return {
    type: 'tool/call',
    seq: SessionSeq(seq),
    time,
    data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name, arguments: argumentText },
  }
}

/** Build a `tool/result` event. */
function toolResult(seq: number, time: number, callId = 'call-1', isError = false, code?: string): SessionEvent {
  return {
    type: 'tool/result',
    seq: SessionSeq(seq),
    time,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId(callId), content: [], isError }),
      ...(code === undefined ? {} : { error: { name: 'ToolError', code } }),
    },
  }
}

describe('foldActivity', () => {
  it('exposes running spans between applied events', () => {
    const folder = createActivityFolder()
    folder.apply(turnStart(0, 10, 1))
    expect(folder.snapshot()).toMatchObject([{ status: 'running' }])
    folder.apply(turnEnd(1, 20, 1, 'completed'))
    expect(folder.snapshot()).toEqual(foldActivity([turnStart(0, 10, 1), turnEnd(1, 20, 1, 'completed')]))
    expect(createActivityFolder().snapshot()).toEqual([])
  })

  it('folds a completed turn with its intent and tool spans', () => {
    const spans = foldActivity([
      turnStart(0, 100, 1),
      assistant(1, 200, 1, [{ type: 'text', text: '修复排序的空数组问题' }]),
      stepStart(2, 210, 1, 1),
      toolCall(3, 300, 'read', { path: 'src/math.ts' }),
      toolResult(4, 400),
      stepEnd(5, 500, 1, 1),
      turnEnd(6, 600, 1, 'completed'),
    ])
    expect(spans.map(span => span.kind)).toEqual(['turn', 'step', 'tool'])
    expect(spans[0]).toMatchObject({ status: 'ok', endTime: 600, attributes: { intent: '修复排序的空数组问题' } })
    expect(spans[2]).toMatchObject({ name: 'read', status: 'ok', endTime: 400, attributes: { path: 'src/math.ts' } })
  })

  it('records failure state and the error code of a tool result', () => {
    const spans = foldActivity([
      turnStart(0, 10, 1),
      toolCall(1, 20, 'bash', { command: 'pnpm test' }),
      toolResult(2, 30, 'call-1', true, 'ASSERTION_FAILED'),
    ])
    expect(spans[1]).toMatchObject({ status: 'error', attributes: { command: 'pnpm test', errorCode: 'ASSERTION_FAILED' } })
  })

  it('classifies a shell deletion and keeps its target path', () => {
    const spans = foldActivity([turnStart(0, 10, 1), toolCall(1, 20, 'bash', { command: 'rm -rf notes/old.md' })])
    expect(spans[1]?.attributes).toMatchObject({ op: 'delete', path: 'notes/old.md' })
  })

  it('keeps a plain shell command without a deletion marker', () => {
    const spans = foldActivity([turnStart(0, 10, 1), toolCall(1, 20, 'bash', { command: 'ls -la' })])
    expect(spans[1]?.attributes).not.toMatchObject({ op: 'delete' })
  })

  it('falls back to the command when a removal names no operand', () => {
    const spans = foldActivity([turnStart(0, 10, 1), toolCall(1, 20, 'bash', { command: 'rm -rf' })])
    expect(spans[1]?.attributes).toMatchObject({ op: 'delete', path: 'rm -rf' })
  })

  it('tolerates malformed and non-object arguments', () => {
    const spans = foldActivity([
      turnStart(0, 10, 1),
      rawToolCall(1, 20, 'read', 'not json'),
      rawToolCall(2, 30, 'read', '42'),
    ])
    expect(spans[1]?.attributes).toEqual({})
    expect(spans[2]?.attributes).toEqual({})
  })

  it('maps turn-end reasons to span statuses', () => {
    const spans = foldActivity([
      turnStart(0, 10, 1),
      turnEnd(1, 20, 1, 'error'),
      turnStart(2, 30, 2),
      turnEnd(3, 40, 2, 'blocked'),
      turnStart(4, 50, 3),
      turnEnd(5, 60, 3, 'aborted'),
    ])
    expect(spans.map(span => span.status)).toEqual(['error', 'cancelled', 'cancelled'])
  })

  it('leaves a turn without a closing event running', () => {
    const spans = foldActivity([turnStart(0, 10, 1)])
    expect(spans[0]).toMatchObject({ status: 'running' })
  })

  it('ignores events whose owner never opened', () => {
    const spans = foldActivity([
      turnEnd(0, 5, 9, 'completed'),
      stepEnd(1, 6, 9, 9),
      toolResult(2, 7),
      assistant(3, 8, 9, [{ type: 'text', text: '孤立的消息' }]),
    ])
    expect(spans).toEqual([])
  })

  it('skips non-text and empty assistant blocks when choosing the intent', () => {
    const reasoning = foldActivity([
      turnStart(0, 10, 1),
      assistant(1, 20, 1, [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '  ' }]),
    ])
    expect(reasoning[0]?.attributes?.intent).toBeUndefined()

    const text = foldActivity([
      turnStart(0, 10, 1),
      assistant(1, 20, 1, [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '  真正意图  ' }]),
    ])
    expect(text[0]?.attributes?.intent).toBe('真正意图')
  })

  it('keeps only the first intent of a turn', () => {
    const spans = foldActivity([
      turnStart(0, 10, 1),
      assistant(1, 20, 1, [{ type: 'text', text: '第一个意图' }]),
      assistant(2, 30, 1, [{ type: 'text', text: '第二个意图' }]),
    ])
    expect(spans[0]?.attributes?.intent).toBe('第一个意图')
  })

  it('ignores event types it does not read', () => {
    const spans = foldActivity([
      {
        type: 'assistant/attempt',
        seq: SessionSeq(0),
        time: 1,
        data: { turn: 1, step: 1, stream: [] },
      },
      turnStart(1, 10, 1),
    ])
    expect(spans.map(span => span.kind)).toEqual(['turn'])
  })

  it('feeds the review chain end to end', () => {
    const spans = foldActivity([
      turnStart(0, 100, 1),
      assistant(1, 110, 1, [{ type: 'text', text: '修复排序的空数组问题' }]),
      toolCall(2, 120, 'read', { path: 'src/math.ts' }),
      toolResult(3, 130),
      toolCall(4, 140, 'edit', { path: 'src/math.ts' }),
      toolResult(5, 150),
      toolCall(6, 160, 'bash', { command: 'pnpm test' }),
      toolResult(7, 170),
      turnEnd(8, 180, 1, 'completed'),
    ])
    const result = chainFromSpans(spans)
    expect(result.cards.map(card => card.kind)).toEqual(['intent', 'recon', 'change', 'verify', 'result'])
    expect(result.flags).toEqual([])
  })
})
