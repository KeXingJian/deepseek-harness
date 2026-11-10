# 评审活动链

[English](review-chain.md) | 中文

评审组会在人读到之前把一段已记录的 Session 投影两次：[`dsh-agent-activity`](../../packages/review/agent-activity/README.zh.md) 把已提交的事件折叠成带时长的活动 span，再把 span 变成一条带评审风险标记的简短有序执行链，自身不做任何 I/O；[`dsh-agent-trace`](../../packages/review/agent-trace/README.zh.md) 增量维护同一份折叠的全日志计数，并通过 `ctx.agentTrace` 按会话持久化一份有界摘要。Web 视图 [`dsh-client-ui-agent-chain`](../../packages/client/ui-agent-chain/README.zh.md) 渲染执行链，并拥有所有面向读者的文字：投影只产出消息，不产出句子。

源码：[`packages/review/agent-activity/src/types.ts`](../../packages/review/agent-activity/src/types.ts)、[`packages/review/agent-trace/src/index.ts`](../../packages/review/agent-trace/src/index.ts)

## 采集层

span 是一段有计时的工作单元，带结算状态和 Session 记录下来的评审相关事实。span 按开启它的事件序号排序；`seq` 就是读者在轨迹里对照的位置。

```ts type-equiv
/** One folded activity span produced by the collection layer. */
interface ActivitySpan {
  /** Sequence number of the span's first contributing session event. */
  readonly seq: number
  /** Span family that owns the timing. */
  readonly kind: 'turn' | 'step' | 'request' | 'tool' | 'subagent' | 'workflow' | 'compaction'
  /** Tool name, workflow phase, subagent label, or turn label. */
  readonly name: string
  /** Epoch milliseconds at which the span opened. */
  readonly startTime: number
  /** Epoch milliseconds at which the span closed; absent while it runs. */
  readonly endTime?: number | undefined
  /** Settlement state of the span. */
  readonly status: 'running' | 'ok' | 'error' | 'cancelled' | 'interrupted'
  /**
   * Presentation facts the collection layer attached to this span: the model's
   * tool arguments, a bash removal's derived `path` and `op`, the turn's
   * one-line `intent`, and the recorded `callId` that addresses a tool call in
   * an inspection view.
   */
  readonly attributes?: Readonly<Record<string, string | number | boolean>> | undefined
}
```

`ActivitySummary` 为那些永远不展开 span 列表的视图统计同一批 span。一次折叠通过与 span 列表相同的开启/结算转移推进它，因此增量构造出的摘要与对最终列表调用 `summarizeSpans()` 的结果始终一致。

```ts type-equiv
/** Whole-log counters derived from spans, carried incrementally by the fold. */
interface ActivitySummary {
  /** Opening counts by span family. */
  readonly spansByKind: Readonly<Record<ActivitySpan['kind'], number>>
  /** Current settlement counts; `running` counts spans still open. */
  readonly spansByStatus: Readonly<Record<ActivitySpan['status'], number>>
  /** Summed wall time of settled spans by family, in milliseconds. */
  readonly durationByKind: Readonly<Record<ActivitySpan['kind'], number>>
}
```

`ACTIVITY_TRACE_VERSION` 标明产出该摘要的折叠语义。带有其他版本的持久化摘要来自不同的折叠规则，必须重算而不能直接返回。

## 呈现层

卡片按固定顺序回答评审者的问题；风险标记在卡片之后计算，因此被标记的改动会显示为 warning，而不会改动它来自的 span。`evidenceSeqs` 让每张卡都可核对：不信任某张卡的读者可以打开它依据的序号。

```ts type-equiv
/** The six card kinds a review reader can see. */
type ChainKind = 'intent' | 'recon' | 'change' | 'verify' | 'interrupt' | 'result'
```

```ts type-equiv
/** Visual state of one chain card. */
type ChainStatus = 'ok' | 'error' | 'running' | 'warning'
```

```ts type-equiv
/** File operation one change card records. */
type ChangeOp = 'create' | 'update' | 'delete'
```

卡片标题是消息描述符而不是文本：投影说明适用哪条消息以及要插值的值，呈现层再通过读者的语言字典解析该变体。`intent` 是例外——它就是模型自己写的那句话，原样显示。

```ts type-equiv
/**
 * One card title: the message the presentation layer renders together with the
 * values it interpolates. Recorded text stays verbatim; every other variant
 * names a message the reader's locale dictionary owns.
 */
type ChainTitle =
  /** The turn's own intent sentence, shown as recorded. */
  | { readonly copy: 'intent'; readonly text: string }
  /** Look-around work merged into counted totals. */
  | { readonly copy: 'recon'; readonly files: number; readonly searches: number }
  /** Look-around compressed to reach the display ceiling. */
  | { readonly copy: 'reconCollapsed' }
  /** One subagent hand-off. */
  | { readonly copy: 'subagent'; readonly name: string }
  /** One workflow phase that settled normally. */
  | { readonly copy: 'workflowCompleted'; readonly name: string }
  /** One workflow phase that settled in error. */
  | { readonly copy: 'workflowFailed'; readonly name: string }
  /** A tool call that handed control to a human. */
  | { readonly copy: 'interrupt'; readonly seconds: number }
  /** One file creation, modification, or deletion. */
  | { readonly copy: 'change'; readonly op: ChangeOp; readonly path: string }
  /** A command that settled normally. */
  | { readonly copy: 'verifyPassed'; readonly command: string }
  /** A command that settled in error, with the failure code when one was recorded. */
  | { readonly copy: 'verifyFailed'; readonly command: string; readonly errorCode?: string | undefined }
  /** A folded run of successful verifications. */
  | { readonly copy: 'verifyRun'; readonly count: number }
  /** The closing summary of changed files and verifications. */
  | { readonly copy: 'result'; readonly files: number; readonly verifications: number }
```

```ts type-equiv
/** One readable step of the execution chain. */
interface ChainCard {
  /** Stable identifier derived from the kind and first contributing sequence. */
  readonly id: string
  /** Presentation kind. */
  readonly kind: ChainKind
  /** One-line summary shown without expansion, for the presentation layer to localize. */
  readonly title: ChainTitle
  /** Epoch milliseconds at which the card opened. */
  readonly startedAt: number
  /** Visual state derived from the underlying spans and risk flags. */
  readonly status: ChainStatus
  /** Sequence numbers a reader can open to check the card. */
  readonly evidenceSeqs: readonly number[]
  /** Number of merged occurrences, for repeated work on one target. */
  readonly repeat?: number | undefined
  /** Machine facts the presentation layer can read without parsing titles. */
  readonly meta?: Readonly<Record<string, string | number>> | undefined
}
```

`meta` 以机器可读形式携带同一批记录事实——目标路径、命令、工具名、操作和合并后的计数。展开的卡片用本地化字段名列出它们，风险规则也读取它们而不是解析标题。

```ts type-equiv
/** Severity of a review risk flag. */
type RiskSeverity = 'danger' | 'warn' | 'info'
```

```ts type-equiv
/** One rule's finding: the message the presentation layer localizes, plus its counts. */
type RiskReason =
  | { readonly copy: 'touchesTests' }
  | { readonly copy: 'touchesCi' }
  | { readonly copy: 'deletes'; readonly count: number }
  | { readonly copy: 'outOfScope' }
  | { readonly copy: 'unverified' }
  | { readonly copy: 'gaveUp' }
  | { readonly copy: 'planChurn'; readonly count: number }
```

```ts type-equiv
/** One review risk attached to the chain. */
interface RiskFlag {
  /** Stable rule name. */
  readonly code: string
  /** How strongly the flag blocks a confident review. */
  readonly severity: RiskSeverity
  /** Reader-facing reason, for the presentation layer to localize. */
  readonly reason: RiskReason
  /** Files the rule matched. */
  readonly evidenceFiles: readonly string[]
}
```

## 持久化摘要

已存储的摘要会说明它覆盖到哪个日志位置，因此消费方可以区分当前答案与过期答案，也能区分实时折叠与恢复记录。

```ts type-equiv
/** One Session's summary as a consumer reads it. */
interface AgentTraceSummary {
  /** Fold semantics that produced the summary; compare with the exported constant. */
  readonly traceVersion: number
  /** Last Session event sequence folded into the summary. */
  readonly asOfSeq: number
  /** The whole-log counters at {@link AgentTraceSummary.asOfSeq}. */
  readonly summary: ActivitySummary
}
```

存储记录额外带上摘要所依据的生命周期标签：若同一 id 重建出的会话其 `createdAt` 与记录不同，则不会返回前任生命周期的任何内容。写入失败软着陆，并由 `retentionDays` 与 `maxRecords` 限制规模；既不在活动中也无折叠状态的会话通过可选的 `sessionQuery` 服务的 `readSession(id)` 读回，并按需重新持久化。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagenttrace--agenttrace"></a>

### `ctx.agentTrace` — `AgentTrace`

The trace collection service. Mount it beside `sessions`, the storage stack, and (optionally) `sessionQuery`; every method is read-only for callers and persistence is fail-soft, because a lost summary costs one interactive recompute and must never disturb the Session append path.

```ts cordis-catalog
/**
 * Read one Session's whole-log activity summary.
 * @param sessionId - live or persisted Session identity.
 * @returns the summary and the log position it folded through, or undefined
 *   when the Session is neither live nor readable through `sessionQuery`.
 */
async sessionSummary(sessionId: SessionId): Promise<AgentTraceSummary | undefined>

/**
 * Read one Session's folded activity spans.
 * @param sessionId - live or persisted Session identity.
 * @returns the spans in sequence order, or undefined when the Session is
 *   neither live nor readable through `sessionQuery`. A cold read also
 *   refreshes the stored summary as a side effect.
 */
async sessionTrace(sessionId: SessionId): Promise<readonly ActivitySpan[] | undefined>
```

Types: [SessionId](core.zh.md)

Source: [`packages/review/agent-trace/src/index.ts`](../../packages/review/agent-trace/src/index.ts)
<!-- END GENERATED cordis-surface -->
