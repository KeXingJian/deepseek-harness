# Review activity chain

English | [中文](review-chain.zh.md)

The review group projects a recorded Session twice before a human reads it. [`dsh-agent-activity`](../../packages/review/agent-activity/README.md) folds committed events into timed activity spans and turns those spans into a short ordered chain with review risk flags; it performs no I/O. [`dsh-agent-trace`](../../packages/review/agent-trace/README.md) keeps the whole-log counters of that same fold incrementally and persists one bounded summary per Session behind `ctx.agentTrace`. The Web view [`dsh-client-ui-agent-chain`](../../packages/client/ui-agent-chain/README.md) renders the chain and owns every reader-facing word: the projection emits messages, never sentences.

Source: [`packages/review/agent-activity/src/types.ts`](../../packages/review/agent-activity/src/types.ts), [`packages/review/agent-trace/src/index.ts`](../../packages/review/agent-trace/src/index.ts)

## Collection layer

A span is one timed unit of work with a settlement state and the review-relevant facts the Session recorded about it. Spans are ordered by the sequence of the event that opened them; `seq` is what a reader cross-checks in the transcript.

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

`ActivitySummary` counts the same spans for views that never list them. One fold advances it through the same open/settle transitions the span list uses, so an incrementally built summary and `summarizeSpans()` over the finished list always agree.

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

`ACTIVITY_TRACE_VERSION` names the fold semantics that produced a summary. A persisted summary stamped with another version was folded under different rules and must be recomputed rather than served.

## Presentation layer

Cards answer the reviewer's questions in a fixed order; risk flags are computed after the cards so a flagged change renders as a warning without altering the spans it came from. `evidenceSeqs` keeps every card checkable: a reader who distrusts a card opens the sequence numbers it was built from.

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

A card title is a message descriptor, not text: the projection states which message applies and the values it interpolates, and the presentation layer resolves that variant through the reader's locale dictionary. The `intent` variant is the exception — it is the model's own sentence, shown verbatim.

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

`meta` carries the same recorded facts in machine form — the target path, the command, the tool name, the operation, and the merged counts. The expanded card lists them with localized field names, and the risk rules read them instead of parsing a title.

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

## Persisted summary

A stored summary states which log position it covers, so a consumer can tell a current answer from a stale one and a live fold from a restored record.

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

The stored record adds the lifetime label the summary is keyed by: a Session recreated under an id whose `createdAt` differs from the record's serves nothing from its predecessor lifecycle. Writes are fail-soft and bounded by `retentionDays` and `maxRecords`; a Session that is neither live nor tracked is read back through the optional `sessionQuery` service's `readSession(id)` and re-persisted on demand.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [SessionId](core.md)

Source: [`packages/review/agent-trace/src/index.ts`](../../packages/review/agent-trace/src/index.ts)
<!-- END GENERATED cordis-surface -->
