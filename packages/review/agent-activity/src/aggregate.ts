/**
 * Whole-log activity counters folded from spans.
 *
 * The merge rules live here so the incremental fold and the from-scratch
 * summary of one span list cannot disagree: both account a span through the
 * same open/settle transitions.
 *
 * @module @deepseek-ai/dsh-agent-activity/aggregate
 */

import type { ActivitySpan, ActivitySummary } from './types.ts'

/**
 * Fold semantics of the activity projection. A persisted summary stamped with
 * another version was folded under different rules and must not be served.
 */
export const ACTIVITY_TRACE_VERSION = 1

/**
 * Create the zero summary.
 * @returns counters with no spans accounted.
 */
export function emptyActivitySummary(): ActivitySummary {
  return {
    spansByKind: { turn: 0, step: 0, request: 0, tool: 0, subagent: 0, workflow: 0, compaction: 0 },
    spansByStatus: { running: 0, ok: 0, error: 0, cancelled: 0, interrupted: 0 },
    durationByKind: { turn: 0, step: 0, request: 0, tool: 0, subagent: 0, workflow: 0, compaction: 0 },
  }
}

/**
 * Account one opening span: one more running span of its family.
 * @param summary - the counters before the span opened.
 * @param span - the span as just recorded.
 * @returns the next counters; the input is never mutated.
 */
export function openActivitySpan(summary: ActivitySummary, span: ActivitySpan): ActivitySummary {
  return {
    spansByKind: { ...summary.spansByKind, [span.kind]: summary.spansByKind[span.kind] + 1 },
    spansByStatus: { ...summary.spansByStatus, running: summary.spansByStatus.running + 1 },
    durationByKind: summary.durationByKind,
  }
}

/**
 * Account one settlement transition of a recorded span.
 * @param summary - the counters before the transition.
 * @param previous - the span before the event.
 * @param next - the span after the event.
 * @returns the next counters, or the input reference when nothing settled.
 */
export function settleActivitySpan(
  summary: ActivitySummary,
  previous: ActivitySpan,
  next: ActivitySpan,
): ActivitySummary {
  if (previous.status === next.status && previous.endTime === next.endTime) return summary
  const spansByStatus = { ...summary.spansByStatus, [previous.status]: summary.spansByStatus[previous.status] - 1 }
  spansByStatus[next.status] = spansByStatus[next.status] + 1
  const closedMs = previous.endTime === undefined && next.endTime !== undefined
    ? next.endTime - next.startTime
    : 0
  return {
    spansByKind: summary.spansByKind,
    spansByStatus,
    durationByKind: closedMs === 0
      ? summary.durationByKind
      : { ...summary.durationByKind, [next.kind]: summary.durationByKind[next.kind] + closedMs },
  }
}

/**
 * Summarize a complete span list without any incremental state.
 * @param spans - the folded spans, in sequence order.
 * @returns the counters the incremental fold must also produce for this list.
 */
export function summarizeSpans(spans: readonly ActivitySpan[]): ActivitySummary {
  let summary = emptyActivitySummary()
  for (const span of spans) {
    summary = {
      spansByKind: { ...summary.spansByKind, [span.kind]: summary.spansByKind[span.kind] + 1 },
      spansByStatus: { ...summary.spansByStatus, [span.status]: summary.spansByStatus[span.status] + 1 },
      durationByKind: span.endTime === undefined
        ? summary.durationByKind
        : { ...summary.durationByKind, [span.kind]: summary.durationByKind[span.kind] + (span.endTime - span.startTime) },
    }
  }
  return summary
}
