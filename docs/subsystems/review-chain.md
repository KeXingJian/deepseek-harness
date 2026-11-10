# Review activity chain

English | [中文](review-chain.zh.md)

The review group projects a recorded Session twice before a human reads it. [`dsh-agent-activity`](../../packages/review/agent-activity/README.md) folds committed events into timed activity spans and turns those spans into a short ordered chain with review risk flags; it performs no I/O. [`dsh-agent-trace`](../../packages/review/agent-trace/README.md) keeps the whole-log counters of that same fold incrementally and persists one bounded summary per Session behind `ctx.agentTrace`. The Web view [`dsh-client-ui-agent-chain`](../../packages/client/ui-agent-chain/README.md) renders the chain and owns every reader-facing word: the projection emits messages, never sentences.

Source: [`packages/review/agent-activity/src/types.ts`](../../packages/review/agent-activity/src/types.ts), [`packages/review/agent-trace/src/index.ts`](../../packages/review/agent-trace/src/index.ts)

## Collection layer

A span is one timed unit of work with a settlement state and the review-relevant facts the Session recorded about it. Spans are ordered by the sequence of the event that opened them; `seq` is what a reader cross-checks in the transcript.

```ts type-equiv
/** 采集层生成的一个折叠后的活动跨度。 */
interface ActivitySpan {
  /** 该跨度首个贡献会话事件的序号。 */
  readonly seq: number
  /** 计时所属的跨度类别。 */
  readonly kind: 'turn' | 'step' | 'request' | 'tool' | 'subagent' | 'workflow' | 'compaction'
  /** 工具名、工作流阶段、子代理标签或回合标签。 */
  readonly name: string
  /** 跨度开启时的纪元毫秒数。 */
  readonly startTime: number
  /** 跨度关闭时的纪元毫秒数；跨度运行期间不存在。 */
  readonly endTime?: number | undefined
  /** 该跨度的结束状态。 */
  readonly status: 'running' | 'ok' | 'error' | 'cancelled' | 'interrupted'
  /**
   * 采集层附加到该跨度上的展示信息：模型给出的工具参数（目标文件统一记为
   * `path`）、文件变更工具上报或 bash 删除派生的 `op`、回合的单行 `intent`，
   * 以及在检查视图中定位某次工具调用的已记录 `callId`。
   */
  readonly attributes?: Readonly<Record<string, string | number | boolean>> | undefined
}
```

`ActivitySummary` counts the same spans for views that never list them. One fold advances it through the same open/settle transitions the span list uses, so an incrementally built summary and `summarizeSpans()` over the finished list always agree.

```ts type-equiv
/** 由跨度推导出的全日志计数器，由折叠过程增量维护。 */
interface ActivitySummary {
  /** 按跨度类别统计的开启次数。 */
  readonly spansByKind: Readonly<Record<ActivitySpan['kind'], number>>
  /** 当前的结束状态计数；`running` 统计仍处于打开状态的跨度。 */
  readonly spansByStatus: Readonly<Record<ActivitySpan['status'], number>>
  /** 按类别统计的已结束跨度实际耗时之和，单位为毫秒。 */
  readonly durationByKind: Readonly<Record<ActivitySpan['kind'], number>>
}
```

`ACTIVITY_TRACE_VERSION` names the fold semantics that produced a summary. A persisted summary stamped with another version was folded under different rules and must be recomputed rather than served.

## Presentation layer

Cards answer the reviewer's questions in a fixed order; risk flags are computed after the cards so a flagged change renders as a warning without altering the spans it came from. `evidenceSeqs` keeps every card checkable: a reader who distrusts a card opens the sequence numbers it was built from.

```ts type-equiv
/** 评审者可见的六种卡片类别。 */
type ChainKind = 'intent' | 'recon' | 'change' | 'verify' | 'interrupt' | 'result'
```

```ts type-equiv
/** 单张链路卡片的视觉状态。 */
type ChainStatus = 'ok' | 'error' | 'running' | 'warning'
```

```ts type-equiv
/** 一张变更卡片记录的文件操作。 */
type ChangeOp = 'create' | 'update' | 'delete'
```

A card title is a message descriptor, not text: the projection states which message applies and the values it interpolates, and the presentation layer resolves that variant through the reader's locale dictionary. The `intent` variant is the exception — it is the model's own sentence, shown verbatim.

```ts type-equiv
/**
 * 一张卡片的标题：展示层渲染的消息，以及该消息插值所用的值。已记录的文本保持
 * 原样；其他每种变体只指明一条由读者所在语言字典提供的消息。
 */
type ChainTitle =
  /** 回合自身的意图语句，按记录原样展示。 */
  | { readonly copy: 'intent'; readonly text: string }
  /** 被合并为计数总计的探查类工作。 */
  | { readonly copy: 'recon'; readonly files: number; readonly searches: number }
  /** 为达到展示上限而被压缩的探查类工作。 */
  | { readonly copy: 'reconCollapsed' }
  /** 一次子代理交接。 */
  | { readonly copy: 'subagent'; readonly name: string }
  /** 一个正常结束的工作流阶段。 */
  | { readonly copy: 'workflowCompleted'; readonly name: string }
  /** 一个以错误结束的工作流阶段。 */
  | { readonly copy: 'workflowFailed'; readonly name: string }
  /** 一次将控制权交给人的工具调用。 */
  | { readonly copy: 'interrupt'; readonly seconds: number }
  /** 一次文件创建、修改或删除。 */
  | { readonly copy: 'change'; readonly op: ChangeOp; readonly path: string }
  /** 一条正常结束的命令。 */
  | { readonly copy: 'verifyPassed'; readonly command: string }
  /** 一条以错误结束的命令；若记录了失败码，则一并给出。 */
  | { readonly copy: 'verifyFailed'; readonly command: string; readonly errorCode?: string | undefined }
  /** 一段被折叠的连续成功校验。 */
  | { readonly copy: 'verifyRun'; readonly count: number }
  /** 变更文件与校验的收尾汇总。 */
  | { readonly copy: 'result'; readonly files: number; readonly verifications: number }
```

```ts type-equiv
/** 执行链中一个可读的步骤。 */
interface ChainCard {
  /** 由类别与首个贡献序号推导出的稳定标识符。 */
  readonly id: string
  /** 展示类别。 */
  readonly kind: ChainKind
  /** 未展开时显示的单行摘要，由展示层负责本地化。 */
  readonly title: ChainTitle
  /** 卡片开启时的纪元毫秒数。 */
  readonly startedAt: number
  /** 由底层跨度与风险标记推导出的视觉状态。 */
  readonly status: ChainStatus
  /** 评审者可打开以核对这张卡片的序号。 */
  readonly evidenceSeqs: readonly number[]
  /** 合并后的出现次数，用于同一目标上的重复工作。 */
  readonly repeat?: number | undefined
  /** 展示层无需解析标题即可读取的机器可读信息。 */
  readonly meta?: Readonly<Record<string, string | number>> | undefined
}
```

`meta` carries the same recorded facts in machine form — the target path, the command, the tool name, the operation, and the merged counts. The expanded card lists them with localized field names, and the risk rules read them instead of parsing a title.

```ts type-equiv
/** 评审风险标记的严重程度。 */
type RiskSeverity = 'danger' | 'warn' | 'info'
```

```ts type-equiv
/** 单条规则的发现：由展示层本地化的消息，以及相应计数。 */
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
/** 附加到链路上的一项评审风险。 */
interface RiskFlag {
  /** 稳定的规则名。 */
  readonly code: string
  /** 该标记对可靠评审的阻断程度。 */
  readonly severity: RiskSeverity
  /** 面向评审者的原因，由展示层负责本地化。 */
  readonly reason: RiskReason
  /** 该规则匹配到的文件。 */
  readonly evidenceFiles: readonly string[]
}
```

## Persisted summary

A stored summary states which log position it covers, so a consumer can tell a current answer from a stale one and a live fold from a restored record.

```ts type-equiv
/** 消费者读取时看到的单个 Session 摘要。 */
interface AgentTraceSummary {
  /** 产出该摘要的折叠语义；请与导出的常量比较。 */
  readonly traceVersion: number
  /** 已折叠进该摘要的最后一个 Session 事件序号。 */
  readonly asOfSeq: number
  /** 处于 {@link AgentTraceSummary.asOfSeq} 时的全日志计数。 */
  readonly summary: ActivitySummary
}
```

The stored record adds the lifetime label the summary is keyed by: a Session recreated under an id whose `createdAt` differs from the record's serves nothing from its predecessor lifecycle. Writes are fail-soft and bounded by `retentionDays` and `maxRecords`; a Session that is neither live nor tracked is read back through the optional `sessionQuery` service's `readSession(id)` and re-persisted on demand.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagenttrace--agenttrace"></a>

### `ctx.agentTrace` — `AgentTrace`

trace 采集服务。将它挂载在 `sessions`、存储栈以及（可选的）`sessionQuery` 旁边； 对调用方而言每个方法都是只读的，持久化采用失败软化（fail-soft）策略，因为丢失 摘要只付出一次交互式重算的代价，绝不能干扰 Session 的追加路径。

```ts cordis-catalog
/**
 * 读取单个 Session 全日志的活动摘要。
 * @param sessionId - 活跃或已持久化的 Session 标识。
 * @returns 该摘要及其折叠到的日志位置；当该 Session 既非活跃、也无法通过
 *   `sessionQuery` 读取时返回 undefined。
 */
async sessionSummary(sessionId: SessionId): Promise<AgentTraceSummary | undefined>

/**
 * 读取单个 Session 折叠后的活动 span。
 * @param sessionId - 活跃或已持久化的 Session 标识。
 * @returns 按序号排列的 span；当该 Session 既非活跃、也无法通过 `sessionQuery`
 *   读取时返回 undefined。冷读还会顺带刷新已存储的摘要。
 */
async sessionTrace(sessionId: SessionId): Promise<readonly ActivitySpan[] | undefined>
```

Types: [SessionId](core.md)

Source: [`packages/review/agent-trace/src/index.ts`](../../packages/review/agent-trace/src/index.ts)
<!-- END GENERATED cordis-surface -->
