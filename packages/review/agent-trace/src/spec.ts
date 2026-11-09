/**
 * The agent-trace domain declaration: one `sessions` table keyed by
 * {@link SessionId}, each record the bounded summary one session's folded
 * spans produced. The spec object is the single source of the domain's
 * identity, version, layout, and record schema; the shipped composition's
 * json backend stores it `per-record`, so a flush rewrites one session's
 * document instead of the whole table.
 *
 * @module @deepseek-ai/dsh-agent-trace/src/spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ActivitySummary } from '@deepseek-ai/dsh-agent-activity'

/** Non-negative integer counter. */
const count = z.number().int().nonnegative()

/** Wall time in milliseconds. */
const millis = z.number().nonnegative()

/** Schema of {@link ActivitySummary}; the key set must match the span unions. */
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
 * One stored per-session trace record. `traceVersion` is the fold semantics
 * that produced the summary: a record stamped with another version is ignored
 * and rebuilt. `createdAt` binds the summary to one Session lifecycle, so a
 * recreated session id cannot serve a predecessor's counters. `asOfSeq` is
 * the last event folded.
 */
export const traceRecordSchema = z.object({
  traceVersion: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  asOfSeq: z.number().int().gte(-1),
  updatedAt: z.number().int().nonnegative(),
  summary: activitySummarySchema,
}).strict()

/** One stored per-session trace record. */
export interface TraceRecord {
  readonly traceVersion: number
  readonly createdAt: number
  readonly asOfSeq: number
  readonly updatedAt: number
  readonly summary: ActivitySummary
}

/**
 * The agent-trace domain spec. `invalidRecords: 'backup-and-skip'` treats a
 * summary as disposable derived data: a record that fails the schema is moved
 * aside and the session is recalculated on its next read instead of failing
 * the host boot.
 */
export const agentTraceDomainSpec = defineDomain({
  name: 'agent_trace',
  version: 1,
  invalidRecords: 'backup-and-skip',
  layout: 'per-record',
  tables: { sessions: domainTable<SessionId, TraceRecord>(traceRecordSchema) },
})
