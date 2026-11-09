/**
 * Failure and latency behavior with a controlled storage domain:
 * - a rejected summary write logs and leaves the live fold readable;
 * - a rejected predecessor delete logs without blocking the new lifecycle;
 * - a rejected retention delete logs and keeps the host bootable;
 * - the Session append path never waits for durability.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { emptyActivitySummary } from '@deepseek-ai/dsh-agent-activity'
import AgentTrace from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { TraceRecord } from '../src/spec.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One record as the fake table stores it. */
function record(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceVersion: 1,
    createdAt: 10,
    asOfSeq: 0,
    updatedAt: Date.now(),
    summary: emptyActivitySummary(),
    ...overrides,
  }
}

/** A storage-domain double over an in-memory table; `open` returns the same handle. */
function fakeStorage(options: {
  readonly records?: Readonly<Record<string, TraceRecord>>
  readonly put?: (id: string, value: TraceRecord) => Promise<void>
  readonly remove?: (id: string) => Promise<boolean>
} = {}) {
  const records = new Map<string, TraceRecord>(Object.entries(options.records ?? {}))
  const put = vi.fn(options.put ?? (async (id: string, value: TraceRecord) => { records.set(id, value) }))
  const remove = vi.fn(options.remove ?? (async (id: string) => records.delete(id)))
  const close = vi.fn(async () => {})
  const table = {
    get: (id: string) => records.get(id),
    entries: () => records.entries(),
    keys: () => records.keys(),
    size: records.size,
    put,
    delete: remove,
  }
  return { open: vi.fn(async () => ({ table: () => table, close })), close, table, records, put, remove }
}

const CONFIG: Config = { flushEveryEvents: 100, flushIntervalMs: 60_000, retentionDays: 30, maxRecords: 100 }

/** Boot SessionStore, a fake storage domain, and the service. */
async function bench(storage: ReturnType<typeof fakeStorage>): Promise<{ ctx: Context; fiber: Fiber; trace: AgentTrace }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  ctx.provide('storageDomain', storage)
  const fiber = await ctx.plugin(AgentTrace, CONFIG)
  return { ctx, fiber, trace: ctx.agentTrace }
}

/** Create a Session owned by its own fiber. */
async function ownedSession(ctx: Context, id: SessionId): Promise<{ session: Session; owner: Fiber }> {
  let session: Session | undefined
  const owner = await ctx.plugin(Object.assign((inner: Context) => {
    session = inner.sessions.create(id)
  }, { inject: ['sessions'] }))
  if (session === undefined) throw new Error('the session owner did not create its session')
  return { session, owner }
}

describe('fail-soft persistence', () => {
  it('logs a rejected summary write and keeps the live fold readable', async () => {
    const storage = fakeStorage({ put: () => Promise.reject(new Error('disk full')) })
    const { ctx, trace } = await bench(storage)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const { session } = await ownedSession(ctx, SessionId('write-fails'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('summary write'))
    })
    expect((await trace.sessionSummary(SessionId('write-fails')))?.summary.spansByStatus.ok).toBe(1)
  })

  it('logs a rejected predecessor delete and still answers the new lifecycle', async () => {
    const storage = fakeStorage({
      records: { 'recreated': record({ createdAt: 1, asOfSeq: 3 }) },
      remove: () => Promise.reject(new Error('locked')),
    })
    const { ctx } = await bench(storage)
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ownedSession(ctx, SessionId('recreated'))
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('summary delete'))
    })
    expect(await ctx.agentTrace.sessionSummary(SessionId('recreated')))
      .toEqual({ traceVersion: 1, asOfSeq: -1, summary: emptyActivitySummary() })
  })

  it('logs a rejected retention delete without failing the boot', async () => {
    const storage = fakeStorage({
      records: { stale: record({ updatedAt: Date.now() - 60 * 86_400_000 }) },
      remove: () => Promise.reject(new Error('read-only medium')),
    })
    const { ctx } = await bench(storage)
    const warn = vi.spyOn(ctx.logger, 'warn')
    // The init retention pass already ran on a fresh context; rerun it through
    // a write of a new session id, which is the second prune trigger.
    const { session } = await ownedSession(ctx, SessionId('fresh'))
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('retention pass failed'))
    })
  })

  it('refuses a predecessor summary for a live Session of another lifecycle', async () => {
    const storage = fakeStorage({
      records: { 'live-other': record({ createdAt: 1, asOfSeq: 7 }) },
      remove: () => new Promise(resolve => setTimeout(() => { resolve(true) }, 30)),
    })
    const { ctx, trace } = await bench(storage)
    // A restored Session enters with history, so no fold is seeded; without a
    // query service the stored record is the only candidate, and its
    // lifecycle must not match this one.
    ctx.sessions.create(SessionId('live-other'), {
      seed: [{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }],
    })
    expect(await trace.sessionSummary(SessionId('live-other'))).toBeUndefined()
  })
})

describe('append latency', () => {
  it('never waits for durability on the Session append path', async () => {
    const storage = fakeStorage({ put: () => new Promise<void>(resolve => setTimeout(resolve, 50)) })
    const { ctx, trace } = await bench(storage)
    const { session } = await ownedSession(ctx, SessionId('latency'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // The durable write is still in flight, yet the counters are already current.
    await vi.waitFor(() => {
      expect(storage.put).toHaveBeenCalledOnce()
    })
    expect((await trace.sessionSummary(SessionId('latency')))?.summary.spansByStatus.ok).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 60))
  })
})
