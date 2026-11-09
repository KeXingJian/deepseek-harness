/**
 * Agent activity trace collection (`ctx.agentTrace`): the host-side backing
 * store for review metrics over one Session's folded activity spans.
 *
 * The service keeps one incremental fold per live Session, answers
 * `sessionSummary` from those counters (or from a persisted record for a cold
 * Session), and persists a bounded summary through the `agent_trace` storage
 * domain on `turn/end`, on Session disposal, and on the configured
 * event/interval throttles. No model input, tool, Session event, or UI reads
 * this data yet: the future full-trace view consumes `sessionTrace` and
 * `sessionSummary`, and the chain view keeps folding in the browser.
 *
 * Design authority: `agent-trace-plugin-plan.md` §4 (two-layer projection)
 * and §9 (collection retention policy).
 *
 * @module @deepseek-ai/dsh-agent-trace
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ACTIVITY_TRACE_VERSION, applyActivityEvent, initActivityState,
} from '@deepseek-ai/dsh-agent-activity'
import type { ActivitySpan, ActivityState, ActivitySummary } from '@deepseek-ai/dsh-agent-activity'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { agentTraceDomainSpec } from './spec.ts'
import type { TraceRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTrace: AgentTrace
  }
}

/**
 * Plugin config. Every field is a deployment choice with no universally
 * correct value: write cadence bounds how much work a crash can lose, and the
 * retention pair bounds how much storage the silent collection may occupy.
 */
export interface Config {
  /** Recorded events per Session that force a summary write between mandatory points. */
  flushEveryEvents: number
  /** Longest time (milliseconds) a dirty summary may stay unwritten between mandatory points. */
  flushIntervalMs: number
  /** Age (days) after which a stored summary is pruned on the next collection write. */
  retentionDays: number
  /** Maximum stored summaries; the oldest are pruned beyond this count. */
  maxRecords: number
}

export const Config: z<Config> = z.object({
  flushEveryEvents: z.natural().min(1).required(),
  flushIntervalMs: z.natural().min(1).required(),
  retentionDays: z.natural().min(1).required(),
  maxRecords: z.natural().min(1).required(),
})

/** One Session's summary as a consumer reads it. */
export interface AgentTraceSummary {
  /** Fold semantics that produced the summary; compare with the exported constant. */
  readonly traceVersion: number
  /** Last Session event sequence folded into the summary. */
  readonly asOfSeq: number
  /** The whole-log counters at {@link AgentTraceSummary.asOfSeq}. */
  readonly summary: ActivitySummary
}

/** One Session's incremental fold and the log position it reached. */
interface TrackedState {
  state: ActivityState
  asOfSeq: number
  /** Session lifecycle the fold belongs to; a recreated id has another `createdAt`. */
  readonly createdAt: number
}

/** Write-behind bookkeeping for one Session. */
interface DirtyState {
  /** Recorded events since the last durable write. */
  pending: number
  /** Interval trigger armed at the first dirty event after a clean write. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Milliseconds in one retention day. */
const DAY_MS = 86_400_000

/**
 * The trace collection service. Mount it beside `sessions`, the storage stack,
 * and (optionally) `sessionQuery`; every method is read-only for callers and
 * persistence is fail-soft, because a lost summary costs one interactive
 * recompute and must never disturb the Session append path.
 */
export class AgentTrace extends Service {
  static inject = ['sessions', 'storageDomain']

  static Config: z<Config> = Config

  private table?: KvTable<SessionId, TraceRecord>
  private readonly tracked = new Map<SessionId, TrackedState>()
  private readonly dirty = new Map<SessionId, DirtyState>()
  /** Writes still queued on the domain chain; the disposal flush drains them. */
  private readonly inflight = new Set<Promise<void>>()
  /** Session ids the table held when this service opened plus every id written since. */
  private readonly known = new Set<SessionId>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentTrace')
  }

  /** Open the domain, install the event listeners, and apply retention once. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentTraceDomainSpec)
    const table = domain.table('sessions')
    this.table = table
    for (const id of table.keys()) this.known.add(id)
    // One disposer owns both steps: fiber teardown runs sibling disposers
    // concurrently, so the flush and the close must not be separate effects.
    this.ctx.effect(() => async () => {
      await this.flushAll()
      await domain.close()
    }, 'agentTrace.domain')
    this.ctx.on('session/created', (session: Session) => { this.adopt(session) })
    this.ctx.on('session/event', (session: Session, event) => { this.record(session, event) })
    this.ctx.on('session/disposed', (session: Session) => { this.retire(session) })
    await this.prune()
  }

  /**
   * Read one Session's whole-log activity summary.
   * @param sessionId - live or persisted Session identity.
   * @returns the summary and the log position it folded through, or undefined
   *   when the Session is neither live nor readable through `sessionQuery`.
   */
  async sessionSummary(sessionId: SessionId): Promise<AgentTraceSummary | undefined> {
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) {
      const tracked = await this.ensureLive(live)
      if (tracked !== undefined) return traceSummaryOf(tracked)
      return this.storedSummary(sessionId, live.header.createdAt)
    }
    const stored = this.storedSummary(sessionId)
    if (stored !== undefined) return stored
    const loaded = await this.loadState(sessionId)
    if (loaded === undefined) return undefined
    this.persist(sessionId, loaded)
    return traceSummaryOf(loaded)
  }

  /**
   * Read one Session's folded activity spans.
   * @param sessionId - live or persisted Session identity.
   * @returns the spans in sequence order, or undefined when the Session is
   *   neither live nor readable through `sessionQuery`. A cold read also
   *   refreshes the stored summary as a side effect.
   */
  async sessionTrace(sessionId: SessionId): Promise<readonly ActivitySpan[] | undefined> {
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) {
      const tracked = await this.ensureLive(live)
      return tracked?.state.spans
    }
    const loaded = await this.loadState(sessionId)
    if (loaded === undefined) return undefined
    this.persist(sessionId, loaded)
    return loaded.state.spans
  }

  /** Seed an empty fold for a Session that enters the store before its first event. */
  private adopt(session: Session): void {
    const id = session.header.id
    const stored = this.table?.get(id)
    if (stored !== undefined && stored.createdAt !== session.header.createdAt) {
      // A recreated id must not serve the predecessor lifecycle's counters;
      // queue the delete behind any write still in flight for this id.
      this.known.delete(id)
      this.queueDelete(id)
    }
    // `seq` is the NEXT event's position, so a Session with no event yet reports 0.
    if (session.seq === 0) {
      this.tracked.set(id, { state: initActivityState(), asOfSeq: -1, createdAt: session.header.createdAt })
    }
  }

  /** Advance the tracked fold when one committed event is contiguous. */
  private record(session: Session, event: SessionEventLike): void {
    const id = session.header.id
    const tracked = this.tracked.get(id)
    if (tracked === undefined || event.seq !== tracked.asOfSeq + 1) return
    tracked.state = applyActivityEvent(tracked.state, event)
    tracked.asOfSeq = event.seq
    this.markDirty(id, event.type === 'turn/end')
  }

  /** Count one recorded event and arm the write trigger. */
  private markDirty(id: SessionId, mandatory: boolean): void {
    let dirty = this.dirty.get(id)
    if (dirty === undefined) {
      dirty = { pending: 0, timer: undefined }
      this.dirty.set(id, dirty)
    }
    dirty.pending += 1
    if (mandatory || dirty.pending >= this.config.flushEveryEvents) {
      this.write(id)
      return
    }
    if (dirty.timer !== undefined) return
    // The closure owns this bookkeeping object: retirement clears the timer
    // before deleting the entry, so the callback never fires for a dead Session.
    dirty.timer = setTimeout(() => {
      dirty.timer = undefined
      this.write(id)
    }, this.config.flushIntervalMs)
    dirty.timer.unref()
  }

  /** Queue the current tracked fold as one complete durable record. */
  private write(id: SessionId): void {
    const tracked = this.tracked.get(id)
    /* v8 ignore next -- callers pass an id whose tracked fold they just read */
    if (tracked === undefined) return
    const dirty = this.dirty.get(id)
    if (dirty !== undefined) {
      dirty.pending = 0
      if (dirty.timer !== undefined) clearTimeout(dirty.timer)
      dirty.timer = undefined
    }
    this.persist(id, tracked)
  }

  /** The open domain table; the service is inert until [Service.init] finishes. */
  private requireTable(): KvTable<SessionId, TraceRecord> {
    /* v8 ignore next -- Service.init assigns the table before any listener or read runs */
    if (this.table === undefined) throw new Error('agent-trace: the storage domain is not open')
    return this.table
  }

  /** Queue one complete record for durable replacement. */
  private persist(id: SessionId, tracked: TrackedState): void {
    this.queueWrite(id, {
      traceVersion: ACTIVITY_TRACE_VERSION,
      createdAt: tracked.createdAt,
      asOfSeq: tracked.asOfSeq,
      updatedAt: Date.now(),
      summary: tracked.state.summary,
    })
  }

  /** Replace one stored record; the domain's write chain preserves call order. */
  private queueWrite(id: SessionId, record: TraceRecord): void {
    const table = this.requireTable()
    const write = (async () => {
      try {
        await table.put(id, record)
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent-trace: summary write for session "${String(id)}" failed: ${String(error)}`)
      }
    })()
    this.inflight.add(write)
    void write.finally(() => { this.inflight.delete(write) })
    if (!this.known.has(id)) {
      this.known.add(id)
      void this.prune()
    }
  }

  /** Delete one stored record; the domain's write chain preserves call order. */
  private queueDelete(id: SessionId): void {
    const table = this.requireTable()
    const remove = (async () => {
      try {
        await table.delete(id)
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent-trace: summary delete for session "${String(id)}" failed: ${String(error)}`)
      }
    })()
    this.inflight.add(remove)
    void remove.finally(() => { this.inflight.delete(remove) })
  }

  /** Flush every dirty summary and drain the queued writes. */
  private async flushAll(): Promise<void> {
    for (const id of this.dirty.keys()) this.write(id)
    this.dirty.clear()
    await Promise.allSettled([...this.inflight])
  }

  /** Persist the final summary and drop the Session's fold at disposal. */
  private retire(session: Session): void {
    const id = session.header.id
    if (!this.tracked.has(id)) return
    // The write clears this Session's dirty timer before the entry is dropped.
    this.write(id)
    this.tracked.delete(id)
    this.dirty.delete(id)
  }

  /** Read a valid stored summary, optionally bound to a live lifecycle. */
  private storedSummary(sessionId: SessionId, createdAt?: number): AgentTraceSummary | undefined {
    const record = this.requireTable().get(sessionId)
    if (record === undefined || record.traceVersion !== ACTIVITY_TRACE_VERSION) return undefined
    if (createdAt !== undefined && record.createdAt !== createdAt) return undefined
    return { traceVersion: record.traceVersion, asOfSeq: record.asOfSeq, summary: record.summary }
  }

  /** Fold a live Session's complete log when its tracked state is missing or behind. */
  private async ensureLive(session: Session): Promise<TrackedState | undefined> {
    const id = session.header.id
    const tracked = this.tracked.get(id)
    if (tracked !== undefined && tracked.asOfSeq + 1 >= session.seq) return tracked
    const loaded = await this.loadState(id)
    if (loaded === undefined) return tracked
    this.tracked.set(id, loaded)
    // A rebuilt fold is worth one durable write: it is the only summary a
    // cold read can serve without folding the whole log again.
    this.persist(id, loaded)
    return loaded
  }

  /** Fold one Session's complete stored log without making it live. */
  private async loadState(sessionId: SessionId): Promise<TrackedState | undefined> {
    const snapshot = await this.readLog(sessionId)
    if (snapshot === undefined) return undefined
    let state = initActivityState()
    for (const event of snapshot.events) state = applyActivityEvent(state, event)
    return {
      state,
      asOfSeq: snapshot.events.at(-1)?.seq ?? -1,
      createdAt: snapshot.session.createdAt,
    }
  }

  /** Read one complete logical log through the optional query service. */
  private async readLog(sessionId: SessionId): Promise<SessionLogSnapshot | undefined> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return undefined
    try {
      return await query.readSession(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`agent-trace: session "${String(sessionId)}" is unreadable for backfill: ${String(error)}`)
      return undefined
    }
  }

  /** Enforce the retention day and record-count bounds; failures stay silent. */
  private async prune(): Promise<void> {
    const table = this.requireTable()
    const cutoff = Date.now() - this.config.retentionDays * DAY_MS
    const rows = [...table.entries()].sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    const kept = new Set(rows.slice(0, this.config.maxRecords).map(([id]) => id))
    try {
      for (const [id, record] of rows) {
        if (record.updatedAt >= cutoff && kept.has(id)) continue
        this.known.delete(id)
        await table.delete(id)
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`agent-trace: summary retention pass failed: ${String(error)}`)
    }
  }
}

/** Project one tracked fold as the public summary. */
function traceSummaryOf(tracked: TrackedState): AgentTraceSummary {
  return {
    traceVersion: ACTIVITY_TRACE_VERSION,
    asOfSeq: tracked.asOfSeq,
    summary: tracked.state.summary,
  }
}

/** One committed Session event as the fold consumes it. */
type SessionEventLike = Parameters<typeof applyActivityEvent>[1]

export default AgentTrace
