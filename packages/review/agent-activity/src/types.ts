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

/** One readable step of the execution chain. */
export interface ChainCard {
  /** Stable identifier derived from the kind and first contributing sequence. */
  readonly id: string
  /** Presentation kind. */
  readonly kind: ChainKind
  /** One-line summary shown without expansion. */
  readonly title: string
  /** Expansion-only text. */
  readonly detail?: string | undefined
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

/** One review risk attached to the chain. */
export interface RiskFlag {
  /** Stable rule name. */
  readonly code: string
  /** How strongly the flag blocks a confident review. */
  readonly severity: RiskSeverity
  /** Reader-facing reason. */
  readonly reason: string
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
