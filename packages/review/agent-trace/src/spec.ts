/**
 * agent-trace 的领域声明：一张以 {@link SessionId} 为键的 `sessions` 表，每条记录都是
 * 某个 Session 折叠后的 span 所产出的有界摘要。spec 对象是该领域身份、版本、布局与
 * 记录 schema 的唯一来源；随包发布的组合中，json 后端以 `per-record` 方式存储它，
 * 因此一次 flush 只重写一个 Session 的文档，而不是整张表。
 *
 * @module @deepseek-ai/dsh-agent-trace/src/spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ActivitySummary } from '@deepseek-ai/dsh-agent-activity'

/** 非负整数计数器。 */
const count = z.number().int().nonnegative()

/** 以毫秒计的挂钟时间。 */
const millis = z.number().nonnegative()

/** {@link ActivitySummary} 的 schema；键集合必须与各 span 联合类型一致。 */
export const activitySummarySchema = z.object({
  spansByKind: z.object({
    turn: count,
    step: count,
    request: count,
    tool: count,
    subagent: count,
    workflow: count,
    compaction: count,
  }).strict(),
  spansByStatus: z.object({
    running: count,
    ok: count,
    error: count,
    cancelled: count,
    interrupted: count,
  }).strict(),
  durationByKind: z.object({
    turn: millis,
    step: millis,
    request: millis,
    tool: millis,
    subagent: millis,
    workflow: millis,
    compaction: millis,
  }).strict(),
}).strict()

/**
 * 一条存储的、按 Session 划分的 trace 记录。`traceVersion` 是产出该摘要的折叠语义：
 * 标记为其他版本的记录会被忽略并重建。`createdAt` 将摘要绑定到某一个 Session 生命
 * 周期，因此被重建的 session id 无法沿用前任的计数。`asOfSeq` 是最后折叠的事件。
 */
export const traceRecordSchema = z.object({
  traceVersion: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  asOfSeq: z.number().int().gte(-1),
  updatedAt: z.number().int().nonnegative(),
  summary: activitySummarySchema,
}).strict()

/** 一条按 Session 存储的 trace 记录。 */
export interface TraceRecord {
  readonly traceVersion: number
  readonly createdAt: number
  readonly asOfSeq: number
  readonly updatedAt: number
  readonly summary: ActivitySummary
}

/**
 * agent-trace 的领域 spec。`invalidRecords: 'backup-and-skip'` 把摘要视为可丢弃的派生
 * 数据：不满足 schema 的记录会被移到一旁，该 session 在下次读取时重新计算，而不是让
 * 宿主启动失败。
 */
export const agentTraceDomainSpec = defineDomain({
  name: 'agent_trace',
  version: 1,
  invalidRecords: 'backup-and-skip',
  layout: 'per-record',
  tables: { sessions: domainTable<SessionId, TraceRecord>(traceRecordSchema) },
})
