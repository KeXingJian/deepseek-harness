/**
 * Review-oriented activity types shared by the collection and presentation
 * layers.
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

/** One folded activity span produced by the collection layer. */
export interface ActivitySpan {
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

/** The six card kinds a review reader can see. */
export type ChainKind = 'intent' | 'recon' | 'change' | 'verify' | 'interrupt' | 'result'

/** Visual state of one chain card. */
export type ChainStatus = 'ok' | 'error' | 'running' | 'warning'

/** File operation one change card records. */
export type ChangeOp = 'create' | 'update' | 'delete'

/**
 * One card title: the message the presentation layer renders together with the
 * values it interpolates. Recorded text stays verbatim; every other variant
 * names a message the reader's locale dictionary owns.
 */
export type ChainTitle =
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

/** One readable step of the execution chain. */
export interface ChainCard {
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

/** Severity of a review risk flag. */
export type RiskSeverity = 'danger' | 'warn' | 'info'

/** One rule's finding: the message the presentation layer localizes, plus its counts. */
export type RiskReason =
  | { readonly copy: 'touchesTests' }
  | { readonly copy: 'touchesCi' }
  | { readonly copy: 'deletes'; readonly count: number }
  | { readonly copy: 'outOfScope' }
  | { readonly copy: 'unverified' }
  | { readonly copy: 'gaveUp' }
  | { readonly copy: 'planChurn'; readonly count: number }

/** One review risk attached to the chain. */
export interface RiskFlag {
  /** Stable rule name. */
  readonly code: string
  /** How strongly the flag blocks a confident review. */
  readonly severity: RiskSeverity
  /** Reader-facing reason, for the presentation layer to localize. */
  readonly reason: RiskReason
  /** Files the rule matched. */
  readonly evidenceFiles: readonly string[]
}

/** Projection result handed to the presentation layer. */
export interface ChainResult {
  /** Cards in display order, ending with the result card. */
  readonly cards: readonly ChainCard[]
  /** Risk flags ordered by severity. */
  readonly flags: readonly RiskFlag[]
}

/** Whole-log counters derived from spans, carried incrementally by the fold. */
export interface ActivitySummary {
  /** Opening counts by span family. */
  readonly spansByKind: Readonly<Record<ActivitySpan['kind'], number>>
  /** Current settlement counts; `running` counts spans still open. */
  readonly spansByStatus: Readonly<Record<ActivitySpan['status'], number>>
  /** Summed wall time of settled spans by family, in milliseconds. */
  readonly durationByKind: Readonly<Record<ActivitySpan['kind'], number>>
}
