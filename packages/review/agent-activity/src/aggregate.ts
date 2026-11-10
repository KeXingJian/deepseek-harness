/**
 * 由跨度折叠得到的全日志活动计数器。
 *
 * 合并规则集中在此，使增量折叠与对同一份跨度列表从头汇总的结果不会产生分歧：
 * 两者都通过相同的 open/settle 转换来计入一个跨度。
 *
 * @module @deepseek-ai/dsh-agent-activity/aggregate
 */

import type { ActivitySpan, ActivitySummary } from './types.ts'

/**
 * 活动投影的折叠语义。带有其他版本标记的已持久化汇总是在不同规则下折叠出来的，
 * 不得对外提供。
 */
export const ACTIVITY_TRACE_VERSION = 1

/**
 * 创建零值汇总。
 * @returns 尚未计入任何跨度的计数器。
 */
export function emptyActivitySummary(): ActivitySummary {
  return {
    spansByKind: { turn: 0, step: 0, request: 0, tool: 0, subagent: 0, workflow: 0, compaction: 0 },
    spansByStatus: { running: 0, ok: 0, error: 0, cancelled: 0, interrupted: 0 },
    durationByKind: { turn: 0, step: 0, request: 0, tool: 0, subagent: 0, workflow: 0, compaction: 0 },
  }
}

/**
 * 计入一个正在开启的跨度：其所属类别多出一个运行中的跨度。
 * @param summary - 跨度开启之前的计数器。
 * @param span - 刚刚记录的跨度。
 * @returns 下一个计数器；输入永不被修改。
 */
export function openActivitySpan(summary: ActivitySummary, span: ActivitySpan): ActivitySummary {
  return {
    spansByKind: { ...summary.spansByKind, [span.kind]: summary.spansByKind[span.kind] + 1 },
    spansByStatus: { ...summary.spansByStatus, running: summary.spansByStatus.running + 1 },
    durationByKind: summary.durationByKind,
  }
}

/**
 * 计入一个已记录跨度的一次结束状态转换。
 * @param summary - 转换之前的计数器。
 * @param previous - 事件发生前的跨度。
 * @param next - 事件发生后的跨度。
 * @returns 下一个计数器；若没有任何结束发生，则返回输入引用。
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
 * 在不依赖任何增量状态的情况下汇总一份完整的跨度列表。
 * @param spans - 折叠后的跨度，按序号顺序排列。
 * @returns 增量折叠针对该列表也必须产出的计数器。
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
