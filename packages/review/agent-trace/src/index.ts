/**
 * Agent 活动 trace 采集（`ctx.agentTrace`）：面向单个 Session 折叠后的活动 span 提供
 * 评审指标的宿主侧存储。
 *
 * 该服务为每个活跃 Session 维护一份增量折叠，用这些计数（或冷 Session 的持久化记录）
 * 应答 `sessionSummary`，并在 `turn/end`、Session 销毁以及配置的事件数/时间间隔节流
 * 条件下，通过 `agent_trace` 存储域持久化有界摘要。目前没有任何模型输入、工具、
 * Session 事件或 UI 读取这些数据：将来的完整 trace 视图会消费 `sessionTrace` 与
 * `sessionSummary`，而链视图仍在浏览器内继续折叠。
 *
 * 设计依据：`agent-trace-plugin-plan.md` §4（两层投影）与 §9（采集保留策略）。
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
 * 插件配置。每个字段都是部署选择，不存在普遍正确的取值：写入节奏限制了崩溃时可能
 * 丢失的工作量，而两个保留参数限制了这一静默采集可占用的存储量。
 */
export interface Config {
  /** 每个 Session 记录的事件数阈值；达到该值后会在强制写入点之间强制写一次摘要。 */
  flushEveryEvents: number
  /** 脏摘要在强制写入点之间可保持未写入的最长时间（毫秒）。 */
  flushIntervalMs: number
  /** 存储摘要的存活时长（天）；超过后会在下一次采集写入时被清理。 */
  retentionDays: number
  /** 存储摘要的数量上限；超过该数量后最旧的会被清理。 */
  maxRecords: number
}

export const Config: z<Config> = z.object({
  flushEveryEvents: z.natural().min(1).required(),
  flushIntervalMs: z.natural().min(1).required(),
  retentionDays: z.natural().min(1).required(),
  maxRecords: z.natural().min(1).required(),
})

/** 消费者读取时看到的单个 Session 摘要。 */
export interface AgentTraceSummary {
  /** 产出该摘要的折叠语义；请与导出的常量比较。 */
  readonly traceVersion: number
  /** 已折叠进该摘要的最后一个 Session 事件序号。 */
  readonly asOfSeq: number
  /** 处于 {@link AgentTraceSummary.asOfSeq} 时的全日志计数。 */
  readonly summary: ActivitySummary
}

/** 单个 Session 的增量折叠及其已到达的日志位置。 */
interface TrackedState {
  state: ActivityState
  asOfSeq: number
  /** 该折叠所属的 Session 生命周期；被重建的 id 带有另一个 `createdAt`。 */
  readonly createdAt: number
}

/** 单个 Session 的写后（write-behind）记账。 */
interface DirtyState {
  /** 自上次持久化写入以来记录的事件数。 */
  pending: number
  /** 定时触发器，在干净写入后的第一个脏事件上启用。 */
  timer: ReturnType<typeof setTimeout> | undefined
}

/** 一个保留日包含的毫秒数。 */
const DAY_MS = 86_400_000

/**
 * trace 采集服务。将它挂载在 `sessions`、存储栈以及（可选的）`sessionQuery` 旁边；
 * 对调用方而言每个方法都是只读的，持久化采用失败软化（fail-soft）策略，因为丢失
 * 摘要只付出一次交互式重算的代价，绝不能干扰 Session 的追加路径。
 */
export class AgentTrace extends Service {
  static inject = ['sessions', 'storageDomain']

  static Config: z<Config> = Config

  private table?: KvTable<SessionId, TraceRecord>
  private readonly tracked = new Map<SessionId, TrackedState>()
  private readonly dirty = new Map<SessionId, DirtyState>()
  /** 仍排队在域写链上的写入；销毁时的 flush 会排空它们。 */
  private readonly inflight = new Set<Promise<void>>()
  /** 本服务打开时表中已有的 Session id，加上此后写入过的每个 id。 */
  private readonly known = new Set<SessionId>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentTrace')
  }

  /** 打开域、安装事件监听器，并应用一次保留策略。 */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentTraceDomainSpec)
    const table = domain.table('sessions')
    this.table = table
    for (const id of table.keys()) this.known.add(id)
    // 由一个 disposer 同时负责两步：fiber 销毁会并发执行同级 disposer，
    // 因此 flush 与 close 不能拆成两个独立的 effect。
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
   * 读取单个 Session 全日志的活动摘要。
   * @param sessionId - 活跃或已持久化的 Session 标识。
   * @returns 该摘要及其折叠到的日志位置；当该 Session 既非活跃、也无法通过
   *   `sessionQuery` 读取时返回 undefined。
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
   * 读取单个 Session 折叠后的活动 span。
   * @param sessionId - 活跃或已持久化的 Session 标识。
   * @returns 按序号排列的 span；当该 Session 既非活跃、也无法通过 `sessionQuery`
   *   读取时返回 undefined。冷读还会顺带刷新已存储的摘要。
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

  /** 为在首个事件之前就进入存储的 Session 预置一份空折叠。 */
  private adopt(session: Session): void {
    const id = session.header.id
    const stored = this.table?.get(id)
    if (stored !== undefined && stored.createdAt !== session.header.createdAt) {
      // 被重建的 id 不得沿用前任生命周期内的计数；
      // 把删除排到该 id 仍在进行中的任何写入之后。
      this.known.delete(id)
      this.queueDelete(id)
    }
    // `seq` 是下一个事件的位置，因此尚无事件的 Session 报告 0。
    if (session.seq === 0) {
      this.tracked.set(id, { state: initActivityState(), asOfSeq: -1, createdAt: session.header.createdAt })
    }
  }

  /** 当提交的事件与跟踪的折叠连续时，推进该折叠。 */
  private record(session: Session, event: SessionEventLike): void {
    const id = session.header.id
    const tracked = this.tracked.get(id)
    if (tracked === undefined || event.seq !== tracked.asOfSeq + 1) return
    tracked.state = applyActivityEvent(tracked.state, event)
    tracked.asOfSeq = event.seq
    this.markDirty(id, event.type === 'turn/end')
  }

  /** 统计一个已记录事件并启用写入触发器。 */
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
    // 该闭包持有这个记账对象：retire 会先清除定时器再删除条目，
    // 因此回调绝不会为已消亡的 Session 触发。
    dirty.timer = setTimeout(() => {
      dirty.timer = undefined
      this.write(id)
    }, this.config.flushIntervalMs)
    dirty.timer.unref()
  }

  /** 把当前跟踪的折叠作为一条完整的持久化记录排队。 */
  private write(id: SessionId): void {
    const tracked = this.tracked.get(id)
    /* v8 ignore next -- 调用方传入的 id 其折叠刚刚已被读取 */
    if (tracked === undefined) return
    const dirty = this.dirty.get(id)
    if (dirty !== undefined) {
      dirty.pending = 0
      if (dirty.timer !== undefined) clearTimeout(dirty.timer)
      dirty.timer = undefined
    }
    this.persist(id, tracked)
  }

  /** 已打开的域表；在 [Service.init] 完成之前该服务不生效。 */
  private requireTable(): KvTable<SessionId, TraceRecord> {
    /* v8 ignore next -- Service.init 会在任何监听器或读取运行之前先完成该表赋值 */
    if (this.table === undefined) throw new Error('agent-trace: the storage domain is not open')
    return this.table
  }

  /** 排队一条完整记录以进行持久化替换。 */
  private persist(id: SessionId, tracked: TrackedState): void {
    this.queueWrite(id, {
      traceVersion: ACTIVITY_TRACE_VERSION,
      createdAt: tracked.createdAt,
      asOfSeq: tracked.asOfSeq,
      updatedAt: Date.now(),
      summary: tracked.state.summary,
    })
  }

  /** 替换一条已存储的记录；该域的写链保证调用顺序。 */
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

  /** 删除一条已存储的记录；该域的写链保证调用顺序。 */
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

  /** 刷写所有脏摘要，并排空排队的写入。 */
  private async flushAll(): Promise<void> {
    for (const id of this.dirty.keys()) this.write(id)
    this.dirty.clear()
    await Promise.allSettled([...this.inflight])
  }

  /** 在销毁时持久化最终摘要，并丢弃该 Session 的折叠。 */
  private retire(session: Session): void {
    const id = session.header.id
    if (!this.tracked.has(id)) return
    // 这次写入会在删除条目之前清除该 Session 的脏定时器。
    this.write(id)
    this.tracked.delete(id)
    this.dirty.delete(id)
  }

  /** 读取一条有效的已存储摘要，可选择绑定到某个活跃生命周期。 */
  private storedSummary(sessionId: SessionId, createdAt?: number): AgentTraceSummary | undefined {
    const record = this.requireTable().get(sessionId)
    if (record === undefined || record.traceVersion !== ACTIVITY_TRACE_VERSION) return undefined
    if (createdAt !== undefined && record.createdAt !== createdAt) return undefined
    return { traceVersion: record.traceVersion, asOfSeq: record.asOfSeq, summary: record.summary }
  }

  /** 当跟踪状态缺失或落后时，折叠活跃 Session 的完整日志。 */
  private async ensureLive(session: Session): Promise<TrackedState | undefined> {
    const id = session.header.id
    const tracked = this.tracked.get(id)
    if (tracked !== undefined && tracked.asOfSeq + 1 >= session.seq) return tracked
    const loaded = await this.loadState(id)
    if (loaded === undefined) return tracked
    this.tracked.set(id, loaded)
    // 重建出的折叠值得做一次持久化写入：它是冷读无需再次折叠整个日志
    // 就能提供的唯一摘要。
    this.persist(id, loaded)
    return loaded
  }

  /** 折叠单个 Session 的完整已存储日志，但不会使其变为活跃。 */
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

  /** 通过可选的查询服务读取一份完整的逻辑日志。 */
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

  /** 执行保留天数与记录数上限；失败时保持静默。 */
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

/** 把一份跟踪的折叠投影为公开摘要。 */
function traceSummaryOf(tracked: TrackedState): AgentTraceSummary {
  return {
    traceVersion: ACTIVITY_TRACE_VERSION,
    asOfSeq: tracked.asOfSeq,
    summary: tracked.state.summary,
  }
}

/** 折叠消费时看到的一条已提交 Session 事件。 */
type SessionEventLike = Parameters<typeof applyActivityEvent>[1]

export default AgentTrace
