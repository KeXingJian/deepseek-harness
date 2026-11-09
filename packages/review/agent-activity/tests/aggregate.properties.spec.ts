/**
 * Property: the incremental counters the fold keeps across events equal the
 * summary computed from the folded span list, for every event order the fold
 * accepts (including out-of-order closes it ignores).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyActivityEvent, foldActivity, initActivityState, summarizeSpans,
} from '../src/index.ts'

const TURN = fc.integer({ min: 1, max: 3 })
const STEP = fc.integer({ min: 1, max: 3 })
const CALL_ID = fc.integer({ min: 1, max: 4 }).map(number => `call-${String(number)}`)
const REASON = fc.constantFrom('completed', 'blocked', 'aborted', 'error')
const TOOL = fc.constantFrom('read', 'bash', 'write', 'grep')

/** One event the generator can build, independent of its log position. */
type EventSpec =
  | { readonly kind: 'turn-start'; readonly turn: number }
  | { readonly kind: 'turn-end'; readonly turn: number; readonly reason: 'completed' | 'blocked' | 'aborted' | 'error' }
  | { readonly kind: 'step-start'; readonly turn: number; readonly step: number }
  | { readonly kind: 'step-end'; readonly turn: number; readonly step: number }
  | { readonly kind: 'tool-call'; readonly callId: string; readonly name: string }
  | { readonly kind: 'tool-result'; readonly callId: string; readonly isError: boolean }
  | { readonly kind: 'assistant'; readonly turn: number; readonly text: string }

const specArb: fc.Arbitrary<EventSpec> = fc.oneof(
  fc.record({ kind: fc.constant('turn-start' as const), turn: TURN }),
  fc.record({ kind: fc.constant('turn-end' as const), turn: TURN, reason: REASON }),
  fc.record({ kind: fc.constant('step-start' as const), turn: TURN, step: STEP }),
  fc.record({ kind: fc.constant('step-end' as const), turn: TURN, step: STEP }),
  fc.record({ kind: fc.constant('tool-call' as const), callId: CALL_ID, name: TOOL }),
  fc.record({ kind: fc.constant('tool-result' as const), callId: CALL_ID, isError: fc.boolean() }),
  fc.record({ kind: fc.constant('assistant' as const), turn: TURN, text: fc.constantFrom('look around', 'fix it', '') }),
)

const END_REASONS = {
  completed: { kind: 'completed' },
  blocked: { kind: 'blocked' },
  aborted: { kind: 'aborted', reason: { kind: 'legacy' } },
  error: { kind: 'error', error: { message: 'failed', code: 'LLM_FAILED' } },
} as const

/** Build the Session event for one spec at a log position. */
function eventOf(spec: EventSpec, seq: number): SessionEvent {
  const time = seq * 10
  switch (spec.kind) {
    case 'turn-start':
      return { type: 'turn/start', seq: SessionSeq(seq), time, data: { turn: spec.turn } }
    case 'turn-end':
      return { type: 'turn/end', seq: SessionSeq(seq), time, data: { turn: spec.turn, reason: END_REASONS[spec.reason] } }
    case 'step-start':
      return { type: 'step/start', seq: SessionSeq(seq), time, data: { turn: spec.turn, step: spec.step } }
    case 'step-end':
      return { type: 'step/end', seq: SessionSeq(seq), time, data: { turn: spec.turn, step: spec.step } }
    case 'tool-call':
      return {
        type: 'tool/call',
        seq: SessionSeq(seq),
        time,
        data: { turn: 1, step: 1, callId: ToolCallId(spec.callId), name: spec.name, arguments: '{}' },
      }
    case 'tool-result':
      return {
        type: 'tool/result',
        seq: SessionSeq(seq),
        time,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({ callId: ToolCallId(spec.callId), content: [], isError: spec.isError }),
        },
      }
    case 'assistant':
      return {
        type: 'assistant/message',
        seq: SessionSeq(seq),
        time,
        surfaceOp: 'append',
        data: {
          turn: spec.turn,
          step: 1,
          message: createAssistantMessage({
            content: spec.text === '' ? [] : [{ type: 'text', text: spec.text }],
            source: { provider: 'test', model: 'test-model' },
          }),
          stream: [],
        },
      }
  }
}

describe('incremental summary', () => {
  it('equals the from-scratch summary of the folded spans', () => {
    fc.assert(fc.property(fc.array(specArb, { maxLength: 40 }), (specs) => {
      const events = specs.map((spec, index) => eventOf(spec, index))
      let state = initActivityState()
      for (const event of events) state = applyActivityEvent(state, event)
      expect(state.summary).toEqual(summarizeSpans(state.spans))
      expect(state.summary).toEqual(summarizeSpans(foldActivity(events)))
    }))
  })
})
