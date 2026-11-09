/**
 * Review-oriented activity projection for the DeepSeek Harness.
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

export * from './types.ts'
export { chainFromSpans } from './chain.ts'
export { createActivityFolder, foldActivity } from './fold.ts'
export type { ActivityFolder } from './fold.ts'
export { reviewFlags } from './risk.ts'
