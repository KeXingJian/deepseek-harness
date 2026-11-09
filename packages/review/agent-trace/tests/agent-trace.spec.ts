/**
 * AgentTrace behavior over the real storage stack:
 * - a live turn folds incrementally and persists at `turn/end`;
 * - the interval and event throttles write between mandatory points;
 * - plugin disposal flushes a dirty summary;
 * - a cold read serves the stored record, and a Session that predates the
 *   collection is backfilled through `sessionQuery` (including repairing a
 *   stale read after a gap);
 * - retention prunes by age and record count, and a recreated id never
 *   serves its predecessor lifecycle's counters.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import SessionStore, {
  SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { emptyActivitySummary } from '@deepseek-ai/dsh-agent-activity'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import AgentTrace from '../src/index.ts'
import type { AgentTraceSummary, Config } from '../src/index.ts'
import { agentTraceDomainSpec, traceRecordSchema } from '../src/spec.ts'
import type { TraceRecord } from '../src/spec.ts'

const ID = SessionId('trace-session')
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** The JSON-backend document path for one session's record. */
const recordPath = (root: string, id: string): string =>
  join(root, agentTraceDomainSpec.name, 'sessions', `${id}.json`)

/** Read and validate one stored record, or undefined when absent. */
async function recordOf(root: string, id: string): Promise<TraceRecord | undefined> {
  try {
    const document = JSON.parse(await readFile(recordPath(root, id), 'utf8')) as { record: unknown }
    return traceRecordSchema.parse(document.record)
  } catch {
    return undefined
  }
}

interface HarnessOptions {
  readonly config?: Partial<Config>
  readonly query?: { readSession: (sessionId: SessionId) => Promise<SessionLogSnapshot> }
  readonly seed?: Readonly<Record<string, TraceRecord>>
  /** Runs after SessionStore mounts and before the collection plugin does. */
  readonly beforePlugin?: (ctx: Context) => void | Promise<void>
}

/** Boot storage, the domain, SessionStore, an optional query fake, and the service. */
async function harness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-trace-'))
  roots.push(root)
  if (options.seed !== undefined) {
    await mkdir(join(root, agentTraceDomainSpec.name, 'sessions'), { recursive: true })
    for (const [id, record] of Object.entries(options.seed)) {
      await writeFile(recordPath(root, id), JSON.stringify({ version: agentTraceDomainSpec.version, record }))
    }
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await options.beforePlugin?.(ctx)
  if (options.query !== undefined) ctx.provide('sessionQuery', options.query)
  const fiber = await ctx.plugin(AgentTrace, {
    flushEveryEvents: 100,
    flushIntervalMs: 60_000,
    retentionDays: 30,
    maxRecords: 100,
    ...options.config,
  })
  return { ctx, root, fiber, trace: ctx.agentTrace }
}

/** Create a Session owned by its own fiber; disposing `owner` disposes the Session. */
async function ownedSession(ctx: Context, id: SessionId): Promise<{ session: Session; owner: Fiber }> {
  let session: Session | undefined
  const owner = await ctx.plugin(Object.assign((inner: Context) => {
    session = inner.sessions.create(id)
  }, { inject: ['sessions'] }))
  if (session === undefined) throw new Error('the session owner did not create its session')
  return { session, owner }
}

/** Log one complete turn with one tool call. */
function logTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'bash', arguments: '{"command":"go test"}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId('call-1'), content: [], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** Resolve after the next durable `put` for one session. */
function whenWritten(ctx: Context, id: SessionId): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('domain/changed', (change) => {
      if (change.domain !== agentTraceDomainSpec.name || change.table !== 'sessions'
        || change.key !== id || change.operation !== 'put') return
      dispose()
      resolve()
    })
  })
}

/** One fake complete-log observation. */
function snapshotOf(id: SessionId, events: readonly SessionEvent[], createdAt: number): SessionLogSnapshot {
  return {
    session: { version: SESSION_FORMAT_VERSION, id, createdAt, isSeeded: true },
    inheritedEventCount: SessionLogOffset(0),
    events: [...events],
  }
}

/** A stored record with the current fold version. */
function storedRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceVersion: 1,
    createdAt: 10,
    asOfSeq: 0,
    updatedAt: Date.now(),
    summary: emptyActivitySummary(),
    ...overrides,
  }
}

describe('live collection', () => {
  it('collects a live turn, persists it at turn/end, and serves it cold', async () => {
    const b = await harness()
    const { session, owner } = await ownedSession(b.ctx, ID)
    const written = whenWritten(b.ctx, ID)
    logTurn(session)
    await written

    const live = await b.trace.sessionSummary(ID)
    expect(live).toMatchObject({ traceVersion: 1, asOfSeq: 5 })
    expect(live?.summary.spansByKind).toMatchObject({ turn: 1, step: 1, tool: 1 })
    expect(live?.summary.spansByStatus).toMatchObject({ ok: 3, running: 0 })
    expect((await b.trace.sessionTrace(ID))?.map(span => span.kind)).toEqual(['turn', 'step', 'tool'])
    expect((await recordOf(b.root, ID))?.asOfSeq).toBe(5)

    await owner.dispose()
    const cold = await b.trace.sessionSummary(ID)
    expect(cold).toEqual(live)
    // Without sessionQuery a cold trace cannot be rebuilt from the bounded record.
    expect(await b.trace.sessionTrace(ID)).toBeUndefined()
  })

  it('writes a dirty summary when the interval trigger fires', async () => {
    const b = await harness({ config: { flushIntervalMs: 20 } })
    const { session } = await ownedSession(b.ctx, ID)
    const written = whenWritten(b.ctx, ID)
    session.append('turn/start', { turn: 1 })
    await written
    expect((await b.trace.sessionSummary(ID))?.summary.spansByStatus.running).toBe(1)
  })

  it('writes when the configured event count is reached between mandatory points', async () => {
    const b = await harness({ config: { flushEveryEvents: 2 } })
    const { session } = await ownedSession(b.ctx, ID)
    const written = whenWritten(b.ctx, ID)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    await written
    expect((await recordOf(b.root, ID))?.asOfSeq).toBe(1)
  })

  it('flushes a dirty summary when the plugin fiber disposes', async () => {
    const b = await harness()
    const { session } = await ownedSession(b.ctx, ID)
    session.append('turn/start', { turn: 1 })
    await b.fiber.dispose()
    await vi.waitFor(async () => {
      expect((await recordOf(b.root, ID))?.summary.spansByStatus.running).toBe(1)
    })
  })
})

describe('backfill', () => {
  it('folds a Session that predates the collection and repairs a stale read', async () => {
    const seed: SessionEvent[] = []
    let session!: Session
    let observed: SessionEvent[] = []
    let failing = false
    const readSession = vi.fn(async (sessionId: SessionId) => {
      if (failing) throw new Error('transient read failure')
      return snapshotOf(sessionId, observed, 10)
    })
    const b = await harness({
      query: { readSession },
      beforePlugin: (ctx) => {
        session = ctx.sessions.create(ID)
        seed.push(
          session.append('turn/start', { turn: 1 }),
          session.append('step/start', { turn: 1, step: 1 }),
        )
        observed = [...seed]
      },
    })
    // The Session entered the store before the plugin, so only a read can
    // build its fold; the first read observes a log one event behind.
    const call = session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'bash', arguments: '{}' })
    expect((await b.trace.sessionTrace(ID))?.map(span => span.name)).toEqual(['turn:1', 'step:1:1'])

    // The installed fold sits at seq 1 while the log is at seq 2, so the next
    // committed event is not contiguous and must not corrupt it; the following
    // read repairs the gap through a fresh observation.
    observed = [...seed, call]
    const result = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('call-1'), content: [], isError: true }),
    }, { surfaceOp: 'append' })
    observed = [...seed, call, result]
    // An unreadable log leaves the installed stale fold as the best answer.
    failing = true
    expect((await b.trace.sessionSummary(ID))?.asOfSeq).toBe(1)
    failing = false
    const summary = await b.trace.sessionSummary(ID)
    expect(summary?.asOfSeq).toBe(3)
    expect(summary?.summary.spansByKind.tool).toBe(1)
    expect(summary?.summary.spansByStatus.error).toBe(1)
    await vi.waitFor(async () => {
      expect(await recordOf(b.root, ID)).toBeDefined()
    })
  })

  it('survives an unreadable log and falls back to the stored record', async () => {
    const b = await harness()
    const { session } = await ownedSession(b.ctx, ID)
    const written = whenWritten(b.ctx, ID)
    logTurn(session)
    await written
    const live = await b.trace.sessionSummary(ID)
    // A fresh service has no tracked fold; the query service is absent, so the
    // stored record bound to this lifecycle must answer instead.
    await b.fiber.dispose()
    const remounted = await b.ctx.plugin(AgentTrace, {
      flushEveryEvents: 100, flushIntervalMs: 60_000, retentionDays: 30, maxRecords: 100,
    })
    const summary = await b.ctx.agentTrace.sessionSummary(ID)
    expect(summary).toEqual(live)
    await remounted.dispose()
  })

  it('reports nothing for an unknown Session or without a query service', async () => {
    const b = await harness()
    expect(await b.trace.sessionSummary(SessionId('unknown'))).toBeUndefined()
    expect(await b.trace.sessionTrace(SessionId('unknown'))).toBeUndefined()
    const readSession = vi.fn(async () => Promise.reject(new Error('persistence is unreadable')))
    const warn = vi.spyOn(b.ctx.logger, 'warn')
    b.ctx.provide('sessionQuery', { readSession })
    expect(await b.trace.sessionSummary(SessionId('broken'))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable for backfill'))
  })
})

describe('stored records', () => {
  it('serves a cold summary from storage without reading the log', async () => {
    const b = await harness({ seed: { 'cold-1': storedRecord({ asOfSeq: 4 }) } })
    expect(await b.trace.sessionSummary(SessionId('cold-1'))).toMatchObject({ asOfSeq: 4 })
  })

  it('ignores a record folded under other trace semantics', async () => {
    const b = await harness({ seed: { 'old-version': storedRecord({ traceVersion: 99 }) } })
    expect(await b.trace.sessionSummary(SessionId('old-version'))).toBeUndefined()
  })

  it('prunes by age and by record count, keeping the newest bounded set', async () => {
    const now = Date.now()
    const b = await harness({
      config: { retentionDays: 1, maxRecords: 1 },
      seed: {
        expired: storedRecord({ updatedAt: now - 2 * 86_400_000 }),
        older: storedRecord({ updatedAt: now - 1_000 }),
        newest: storedRecord({ updatedAt: now }),
      },
    })
    expect(await recordOf(b.root, 'expired')).toBeUndefined()
    expect(await recordOf(b.root, 'older')).toBeUndefined()
    expect((await b.trace.sessionSummary(SessionId('newest')))?.asOfSeq).toBe(0)
  })

  it('never serves a predecessor lifecycle after a recreated id', async () => {
    const predecessor = storedRecord({ createdAt: 42, asOfSeq: 3 })
    const b = await harness({ seed: { [ID]: predecessor } })
    // A live creation with the same id carries another createdAt; the
    // predecessor record must not answer for it.
    await ownedSession(b.ctx, ID)
    const summary = await b.trace.sessionSummary(ID)
    expect(summary).toEqual({ traceVersion: 1, asOfSeq: -1, summary: emptyActivitySummary() })
    await vi.waitFor(async () => {
      expect(await recordOf(b.root, ID)).toBeUndefined()
    })
  })

  it('answers a live Session whose log is unreadable from its stored record', async () => {
    const b = await harness()
    const { session } = await ownedSession(b.ctx, ID)
    const written = whenWritten(b.ctx, ID)
    logTurn(session)
    await written
    const live = await b.trace.sessionSummary(ID)
    await b.fiber.dispose()
    // Reboot the service without a query service: the live Session's tracked
    // fold is gone and its log cannot be read, so storage must answer.
    const remounted = await b.ctx.plugin(AgentTrace, {
      flushEveryEvents: 100, flushIntervalMs: 60_000, retentionDays: 30, maxRecords: 100,
    })
    expect(await b.ctx.agentTrace.sessionSummary(ID)).toEqual(live)
    await remounted.dispose()
  })
})

describe('cold backfill', () => {
  it('folds a cold Session through sessionQuery and stores its summary', async () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1_000, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 1_500, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const readSession = vi.fn(async (sessionId: SessionId) => snapshotOf(sessionId, events, 10))
    const b = await harness({ query: { readSession } })
    const summary = await b.trace.sessionSummary(SessionId('cold-log'))
    expect(summary).toMatchObject({ asOfSeq: 1 })
    expect(summary?.summary.spansByKind.turn).toBe(1)
    expect(summary?.summary.durationByKind.turn).toBe(500)
    await vi.waitFor(async () => {
      expect((await recordOf(b.root, 'cold-log'))?.asOfSeq).toBe(1)
    })
    expect((await b.trace.sessionTrace(SessionId('cold-log')))?.map(span => span.name)).toEqual(['turn:1'])
    expect(readSession).toHaveBeenCalledTimes(2)
    // An empty stored log folds to the initial cursor, not a fabricated event.
    readSession.mockResolvedValueOnce(snapshotOf(SessionId('empty-log'), [], 10))
    expect(await b.trace.sessionSummary(SessionId('empty-log'))).toMatchObject({ asOfSeq: -1 })
  })
})

describe('lifecycle edges', () => {
  it('keeps one interval timer across several dirty events', async () => {
    const b = await harness({ config: { flushIntervalMs: 30 } })
    const { session } = await ownedSession(b.ctx, ID)
    const written = whenWritten(b.ctx, ID)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    await written
    expect((await recordOf(b.root, ID))?.asOfSeq).toBe(1)
  })

  it('persists an empty Session when it disposes', async () => {
    const b = await harness()
    const { owner } = await ownedSession(b.ctx, ID)
    const written = whenWritten(b.ctx, ID)
    await owner.dispose()
    await written
    expect((await recordOf(b.root, ID))?.asOfSeq).toBe(-1)
  })

  it('cancels the interval timer when a dirty Session disposes', async () => {
    const b = await harness()
    const { session, owner } = await ownedSession(b.ctx, ID)
    const written = whenWritten(b.ctx, ID)
    session.append('turn/start', { turn: 1 })
    await owner.dispose()
    await written
    expect((await recordOf(b.root, ID))?.asOfSeq).toBe(0)
  })

  it('ignores disposal of a Session it never tracked', async () => {
    let owner: Fiber | undefined
    const b = await harness({
      beforePlugin: async (ctx) => {
        owner = await ctx.plugin(Object.assign((inner: Context) => {
          const session = inner.sessions.create(SessionId('pre-existing'))
          session.append('turn/start', { turn: 1 })
        }, { inject: ['sessions'] }))
      },
    })
    await owner?.dispose()
    expect(await recordOf(b.root, 'pre-existing')).toBeUndefined()
  })
})

describe('summary shape', () => {
  it('keeps an empty Session at zero counters', async () => {
    const b = await harness()
    await ownedSession(b.ctx, ID)
    const summary: AgentTraceSummary | undefined = await b.trace.sessionSummary(ID)
    expect(summary).toEqual({ traceVersion: 1, asOfSeq: -1, summary: emptyActivitySummary() })
    expect(await b.trace.sessionTrace(ID)).toEqual([])
  })
})
