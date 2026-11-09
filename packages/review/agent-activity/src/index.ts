/**
 * Review-oriented activity projection for the DeepSeek Harness.
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

export * from './types.ts'
export {
  ACTIVITY_TRACE_VERSION, emptyActivitySummary, openActivitySpan, settleActivitySpan, summarizeSpans,
} from './aggregate.ts'
export { chainFromSpans } from './chain.ts'
export { applyActivityEvent, createActivityFolder, foldActivity, initActivityState } from './fold.ts'
export type { ActivityFolder, ActivityState } from './fold.ts'
export { reviewFlags } from './risk.ts'
