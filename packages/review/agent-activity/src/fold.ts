/**
 * Folding from durable Session events to activity spans.
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ActivitySpan } from './types.ts'

/** Attributes a span accepts while it is being built. */
type MutableAttributes = Record<string, string | number | boolean>

/** One span under construction. */
interface MutableSpan {
  seq: number
  kind: ActivitySpan['kind']
  name: string
  startTime: number
  endTime?: number
  status: ActivitySpan['status']
  attributes: MutableAttributes
}

/**
 * Incremental folder: one committed event in, current spans out.
 *
 * A carrier that sees events arrive keeps one folder per Session instead of
 * re-folding the log, so a live view costs one switch per event.
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

/**
 * Create one incremental folder.
 * @returns a folder that accepts committed events in log order.
 */
export function createActivityFolder(): ActivityFolder {
  const spans: MutableSpan[] = []
  const turns = new Map<number, MutableSpan>()
  const steps = new Map<string, MutableSpan>()
  const calls = new Map<string, MutableSpan>()

  const apply = (event: SessionEvent): void => {
    switch (event.type) {
      case 'turn/start': {
        const span: MutableSpan = {
          seq: event.seq,
          kind: 'turn',
          name: `turn:${String(event.data.turn)}`,
          startTime: event.time,
          status: 'running',
          attributes: {},
        }
        turns.set(event.data.turn, span)
        spans.push(span)
        break
      }
      case 'turn/end': {
        const span = turns.get(event.data.turn)
        if (span === undefined) break
        span.endTime = event.time
        span.status = statusOf(event.data.reason)
        turns.delete(event.data.turn)
        break
      }
      case 'step/start': {
        const key = `${String(event.data.turn)}:${String(event.data.step)}`
        const span: MutableSpan = {
          seq: event.seq,
          kind: 'step',
          name: `step:${key}`,
          startTime: event.time,
          status: 'running',
          attributes: {},
        }
        steps.set(key, span)
        spans.push(span)
        break
      }
      case 'step/end': {
        const key = `${String(event.data.turn)}:${String(event.data.step)}`
        const span = steps.get(key)
        if (span === undefined) break
        span.endTime = event.time
        span.status = 'ok'
        steps.delete(key)
        break
      }
      case 'assistant/message': {
        const span = turns.get(event.data.turn)
        if (span === undefined) break
        const intent = intentOf(event.data.message.content)
        if (intent !== undefined && span.attributes.intent === undefined) span.attributes.intent = intent
        break
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
        const span: MutableSpan = {
          seq: event.seq,
          kind: 'tool',
          name: event.data.name,
          startTime: event.time,
          status: 'running',
          attributes,
        }
        calls.set(String(event.data.callId), span)
        spans.push(span)
        break
      }
      case 'tool/result': {
        const key = String(event.data.message.toolCallId)
        const span = calls.get(key)
        if (span === undefined) break
        span.endTime = event.time
        span.status = event.data.message.isError === true ? 'error' : 'ok'
        if (event.data.error !== undefined) span.attributes.errorCode = event.data.error.code
        calls.delete(key)
        break
      }
      default:
        break
    }
  }

  return { apply, snapshot: () => spans }
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
