# 评审活动链

[English](review-chain.md) | 中文

评审组会在人读到之前把一段已记录的 Session 投影两次：[`dsh-agent-activity`](../../packages/review/agent-activity/README.zh.md) 把已提交的事件折叠成带时长的活动 span，再把 span 变成一条带评审风险标记的简短有序执行链，自身不做任何 I/O；[`dsh-agent-trace`](../../packages/review/agent-trace/README.zh.md) 增量维护同一份折叠的全日志计数，并通过 `ctx.agentTrace` 按会话持久化一份有界摘要。Web 视图 [`dsh-client-ui-agent-chain`](../../packages/client/ui-agent-chain/README.zh.md) 渲染执行链，并拥有所有面向读者的文字：投影只产出消息，不产出句子。

源码：[`packages/review/agent-activity/src/types.ts`](../../packages/review/agent-activity/src/types.ts)、[`packages/review/agent-trace/src/index.ts`](../../packages/review/agent-trace/src/index.ts)

## 采集层

span 是一段有计时的工作单元，带结算状态和 Session 记录下来的评审相关事实。span 按开启它的事件序号排序；`seq` 就是读者在轨迹里对照的位置。

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

`ActivitySummary` 为那些永远不展开 span 列表的视图统计同一批 span。一次折叠通过与 span 列表相同的开启/结算转移推进它，因此增量构造出的摘要与对最终列表调用 `summarizeSpans()` 的结果始终一致。

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

`ACTIVITY_TRACE_VERSION` 标明产出该摘要的折叠语义。带有其他版本的持久化摘要来自不同的折叠规则，必须重算而不能直接返回。

## 呈现层

卡片按固定顺序回答评审者的问题；风险标记在卡片之后计算，因此被标记的改动会显示为 warning，而不会改动它来自的 span。`evidenceSeqs` 让每张卡都可核对：不信任某张卡的读者可以打开它依据的序号。

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

卡片标题是消息描述符而不是文本：投影说明适用哪条消息以及要插值的值，呈现层再通过读者的语言字典解析该变体。`intent` 是例外——它就是模型自己写的那句话，原样显示。

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

`meta` 以机器可读形式携带同一批记录事实——目标路径、命令、工具名、操作和合并后的计数。展开的卡片用本地化字段名列出它们，风险规则也读取它们而不是解析标题。

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

## 持久化摘要

已存储的摘要会说明它覆盖到哪个日志位置，因此消费方可以区分当前答案与过期答案，也能区分实时折叠与恢复记录。

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

存储记录额外带上摘要所依据的生命周期标签：若同一 id 重建出的会话其 `createdAt` 与记录不同，则不会返回前任生命周期的任何内容。写入失败软着陆，并由 `retentionDays` 与 `maxRecords` 限制规模；既不在活动中也无折叠状态的会话通过可选的 `sessionQuery` 服务的 `readSession(id)` 读回，并按需重新持久化。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [SessionId](core.zh.md)

Source: [`packages/review/agent-trace/src/index.ts`](../../packages/review/agent-trace/src/index.ts)
<!-- END GENERATED cordis-surface -->
