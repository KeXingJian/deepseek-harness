/**
 * Folding from durable Session events to activity spans.
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ActivitySpan } from './types.ts'

/** Attributes a span accepts while it is being built. */
type MutableAttributes = Record<string, string | number | boolean>

/**
 * One fold state, JSON-serializable so a projection can checkpoint it.
 *
 * `open*` records map an owner identity to the index of its running span, so
 * one event updates one span without scanning the log or the span list.
 */
export interface ActivityState {
  /** Spans in sequence order. */
  spans: ActivitySpan[]
  /** Running turn number to span index. */
  openTurns: Record<string, number>
  /** Running `turn:step` pair to span index. */
  openSteps: Record<string, number>
  /** Running tool call id to span index. */
  openCalls: Record<string, number>
}

/** Argument keys a review chain reads. */
const READ_ARGUMENTS = ['path', 'file', 'command', 'pattern', 'op'] as const

/** Target of a shell removal command, or the command itself when it names no operand. */
function removalTarget(command: string): string | undefined {
  if (!/^rm(\s|$)/.test(command)) return undefined
  const operands = command.split(/\s+/).filter(token => token !== '' && !token.startsWith('-')).slice(1)
  return operands.at(-1) ?? command
}

/** Read one string field from a parsed argument object. */
function argumentString(source: object, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** Extract review-relevant attributes from model-produced tool arguments. */
function attributesOf(argumentsJson: string): MutableAttributes {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    // Tool arguments are model output; malformed JSON simply carries no parsed attributes.
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const attributes: MutableAttributes = {}
  for (const key of READ_ARGUMENTS) {
    const value = argumentString(parsed, key)
    if (value !== undefined) attributes[key] = value
  }
  return attributes
}

/** Map a turn-end reason to a span status. */
function statusOf(reason: TurnEndReason): ActivitySpan['status'] {
  switch (reason.kind) {
    case 'error':
      return 'error'
    case 'aborted':
    case 'blocked':
      return 'cancelled'
    default:
      return 'ok'
  }
}

/** First non-empty text block of an assistant message, if any. */
function intentOf(content: readonly { type: string; text?: string }[]): string | undefined {
  for (const block of content) {
    if (block.type !== 'text') continue
    const text = block.text?.trim()
    if (text !== undefined && text !== '') return text
  }
  return undefined
}

/** Replace one span, preserving every other span reference. */
function closed(state: ActivityState, index: number, span: ActivitySpan): ActivityState {
  const spans = [...state.spans]
  spans[index] = span
  return { ...state, spans }
}

/** Drop one owner key from a record. */
function released(record: Record<string, number>, key: string): Record<string, number> {
  const next: Record<string, number> = {}
  for (const [owner, index] of Object.entries(record)) {
    if (owner !== key) next[owner] = index
  }
  return next
}

/**
 * Create one empty fold state.
 * @returns state with no spans and no open owners.
 */
export function initActivityState(): ActivityState {
  return { spans: [], openTurns: {}, openSteps: {}, openCalls: {} }
}

/**
 * Apply one committed Session event to a fold state.
 * @param state - the current state; it is never mutated.
 * @param event - the event in log order.
 * @returns the next state, or the same reference when the event changes nothing.
 */
export function applyActivityEvent(state: ActivityState, event: SessionEvent): ActivityState {
  switch (event.type) {
    case 'turn/start': {
      const span: ActivitySpan = {
        seq: event.seq,
        kind: 'turn',
        name: `turn:${String(event.data.turn)}`,
        startTime: event.time,
        status: 'running',
      }
      return {
        ...state,
        spans: [...state.spans, span],
        openTurns: { ...state.openTurns, [String(event.data.turn)]: state.spans.length },
      }
    }
    case 'turn/end': {
      const key = String(event.data.turn)
      const index = state.openTurns[key]
      const span = index === undefined ? undefined : state.spans[index]
      if (index === undefined || span === undefined) return state
      return {
        ...closed(state, index, { ...span, endTime: event.time, status: statusOf(event.data.reason) }),
        openTurns: released(state.openTurns, key),
      }
    }
    case 'step/start': {
      const key = `${String(event.data.turn)}:${String(event.data.step)}`
      const span: ActivitySpan = {
        seq: event.seq,
        kind: 'step',
        name: `step:${key}`,
        startTime: event.time,
        status: 'running',
      }
      return {
        ...state,
        spans: [...state.spans, span],
        openSteps: { ...state.openSteps, [key]: state.spans.length },
      }
    }
    case 'step/end': {
      const key = `${String(event.data.turn)}:${String(event.data.step)}`
      const index = state.openSteps[key]
      const span = index === undefined ? undefined : state.spans[index]
      if (index === undefined || span === undefined) return state
      return {
        ...closed(state, index, { ...span, endTime: event.time, status: 'ok' }),
        openSteps: released(state.openSteps, key),
      }
    }
    case 'assistant/message': {
      const index = state.openTurns[String(event.data.turn)]
      const span = index === undefined ? undefined : state.spans[index]
      if (index === undefined || span === undefined || span.attributes?.intent !== undefined) return state
      const intent = intentOf(event.data.message.content)
      if (intent === undefined) return state
      return closed(state, index, { ...span, attributes: { ...span.attributes, intent } })
    }
    case 'tool/call': {
      const attributes = attributesOf(event.data.arguments)
      const command = attributes.command
      if (event.data.name === 'bash' && typeof command === 'string') {
        const target = removalTarget(command)
        if (target !== undefined) {
          attributes.op = 'delete'
          attributes.path = target
        }
      }
      const span: ActivitySpan = {
        seq: event.seq,
        kind: 'tool',
        name: event.data.name,
        startTime: event.time,
        status: 'running',
        attributes,
      }
      return {
        ...state,
        spans: [...state.spans, span],
        openCalls: { ...state.openCalls, [String(event.data.callId)]: state.spans.length },
      }
    }
    case 'tool/result': {
      const key = String(event.data.message.toolCallId)
      const index = state.openCalls[key]
      const span = index === undefined ? undefined : state.spans[index]
      if (index === undefined || span === undefined) return state
      const attributes = event.data.error === undefined
        ? span.attributes
        : { ...span.attributes, errorCode: event.data.error.code }
      return {
        ...closed(state, index, {
          ...span,
          endTime: event.time,
          status: event.data.message.isError === true ? 'error' : 'ok',
          ...(attributes === undefined ? {} : { attributes }),
        }),
        openCalls: released(state.openCalls, key),
      }
    }
    default:
      return state
  }
}

/**
 * Incremental folder over one Session's events.
 *
 * A carrier that sees events arrive keeps one folder per Session instead of
 * re-folding the log, so a live view costs one call per event.
 */
export interface ActivityFolder {
  /**
   * Apply one committed Session event.
   * @param event - the event in log order.
   */
  apply(event: SessionEvent): void
  /**
   * Read the spans recorded so far, in sequence order.
   * @returns the current spans; callers must not mutate them.
   */
  snapshot(): ActivitySpan[]
}

/**
 * Create one incremental folder.
 * @returns a folder that accepts committed events in log order.
 */
export function createActivityFolder(): ActivityFolder {
  let state = initActivityState()
  return {
    apply: (event) => {
      state = applyActivityEvent(state, event)
    },
    snapshot: () => [...state.spans],
  }
}

/**
 * Fold durable Session events into activity spans for the review chain.
 * @param events - the session log in ascending sequence order.
 * @returns spans in sequence order; a span whose closing event never arrived stays running.
 */
export function foldActivity(events: readonly SessionEvent[]): ActivitySpan[] {
  const folder = createActivityFolder()
  for (const event of events) folder.apply(event)
  return folder.snapshot()
}
